#!/usr/bin/env python3
"""CLI transport for the Temporal Omarchy plugin.

The plugin talks to most servers over the HTTP API, but that listener is off by
default and cannot present client certificates. For those servers the panel
shells out here instead, and this collector runs the equivalent `temporal`
commands and prints one JSON document.

It deliberately does **not** parse anything: it hands back the raw `-o json`
payloads under stable keys, and Model.js parses them with exactly the same code
it uses for the HTTP responses. One parsing layer, two transports.

Usage:

    collect.py '<spec json>'      # or: collect.py -   (spec on stdin)

Spec:

    {"mode": "poll",  "address": "localhost:7233", "namespaces": [...],
     "recentLimit": 25, "timeoutSec": 20, "cli": "temporal",
     "profile": "", "apiKey": ""}

Modes: poll, workflow, taskqueue, namespace, discover.
Every mode prints {"ok": true, ...} or {"ok": false, "error": "..."}.
"""

import json
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

# Each `temporal` call is a fresh 40MB binary start, so a namespace fan-out is
# run concurrently: wall time is then roughly one call rather than N.
MAX_WORKERS = 8


class CliError(Exception):
    pass


def connection_args(spec):
    """Flags identifying which server to talk to.

    A profile carries its own address, credentials and TLS material, so passing
    --address alongside it would override exactly the thing the profile exists
    to supply.
    """
    args = []
    profile = str(spec.get("profile") or "").strip()
    if profile:
        args += ["--profile", profile]
    elif spec.get("address"):
        args += ["--address", str(spec["address"])]
    if spec.get("apiKey"):
        args += ["--api-key", str(spec["apiKey"])]
    return args


def run(spec, args, namespace=None):
    """Run one `temporal` command and return its parsed JSON."""
    cli = str(spec.get("cli") or "temporal")
    cmd = [cli] + args + connection_args(spec)
    if namespace:
        cmd += ["--namespace", namespace]
    cmd += ["--output", "json"]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=float(spec.get("timeoutSec") or 20),
        )
    except FileNotFoundError:
        raise CliError(f"{cli} not found on PATH")
    except subprocess.TimeoutExpired:
        raise CliError("temporal timed out")

    if proc.returncode != 0:
        raise CliError(clean_error(proc.stderr or proc.stdout))

    text = (proc.stdout or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise CliError("unreadable temporal output")


def clean_error(text):
    """Reduce a CLI error to the one line worth putting in a bar panel."""
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    if not lines:
        return "temporal failed"
    message = lines[0]
    for prefix in ("Error: ", "error: "):
        if message.startswith(prefix):
            message = message[len(prefix):]
    return message if len(message) <= 160 else message[:157] + "..."


def namespace_bundle(spec, namespace):
    """The two calls the poll needs for one namespace, as raw payloads."""
    limit = int(spec.get("recentLimit") or 25)
    out = {"count": None, "list": None, "error": None}
    try:
        out["count"] = run(spec, ["workflow", "count", "--query", "GROUP BY ExecutionStatus"], namespace)
    except CliError as err:
        out["error"] = str(err)
    try:
        out["list"] = run(spec, ["workflow", "list", "--limit", str(limit)], namespace)
    except CliError as err:
        # A count that worked and a list that did not is still worth showing, so
        # the first error is kept rather than overwritten.
        out["error"] = out["error"] or str(err)
    return out


def mode_poll(spec):
    """Namespaces, cluster identity, and per-namespace counts and executions."""
    pinned = [str(n) for n in (spec.get("namespaces") or []) if str(n).strip()]

    if pinned:
        names, namespaces_payload = pinned, None
    else:
        namespaces_payload = run(spec, ["operator", "namespace", "list"])
        names = []
        for entry in namespaces_payload or []:
            name = ((entry or {}).get("namespaceInfo") or {}).get("name") or ""
            if name and name != "temporal-system":
                names.append(name)
        names.sort()

    # Cluster identity is cheap and only changes on upgrade, but it is what
    # makes a server look like a server rather than a bag of namespaces.
    try:
        cluster = run(spec, ["operator", "cluster", "describe"])
    except CliError:
        cluster = None

    results = {}
    if names:
        with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(names))) as pool:
            for name, bundle in zip(names, pool.map(lambda n: namespace_bundle(spec, n), names)):
                results[name] = bundle

    return {
        "ok": True,
        "cluster": cluster,
        "namespaces": namespaces_payload,
        "namespaceNames": names,
        "results": results,
    }


# One mode per drill-down level, so opening a level over the CLI costs exactly
# one process start no matter how many calls the level actually needs.


def mode_workflow(spec):
    args = ["workflow", "describe", "--workflow-id", str(spec.get("workflowId") or "")]
    if spec.get("runId"):
        args += ["--run-id", str(spec["runId"])]
    return {"ok": True, "detail": run(spec, args, str(spec.get("namespace") or ""))}


def mode_taskqueue(spec):
    args = ["task-queue", "describe", "--task-queue", str(spec.get("taskQueue") or "")]
    return {"ok": True, "taskQueue": run(spec, args, str(spec.get("namespace") or ""))}


def mode_namespace(spec):
    """Everything the namespace level shows that the poll does not already have."""
    namespace = str(spec.get("namespace") or "")

    def schedules():
        return run(spec, ["schedule", "list"], namespace)

    def batch():
        return run(spec, ["batch", "list"], namespace)

    def describe():
        return run(spec, ["operator", "namespace", "describe", namespace])

    out = {"ok": True, "schedules": None, "batch": None, "namespace": None, "error": None}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {
            "schedules": pool.submit(schedules),
            "batch": pool.submit(batch),
            "namespace": pool.submit(describe),
        }
        for key, future in futures.items():
            try:
                out[key] = future.result()
            except CliError as err:
                # Batch listing is unsupported on some deployments; that should
                # not blank out the schedules that did come back.
                out["error"] = out["error"] or str(err)
    return out


def probe_address(spec, address):
    """Is there a Temporal server on this gRPC address, and which one?"""
    probe = dict(spec)
    probe["address"] = address
    probe["profile"] = ""
    probe["timeoutSec"] = min(float(spec.get("timeoutSec") or 6), 6)
    try:
        info = run(probe, ["operator", "cluster", "describe"]) or {}
        return {
            "address": address,
            "ok": True,
            "version": info.get("serverVersion") or "",
            "clusterName": info.get("clusterName") or "",
        }
    except CliError as err:
        return {"address": address, "ok": False, "error": str(err)}


def mode_discover(spec):
    """Everything on this machine that onboarding could offer to add.

    Two independent sources: gRPC ports that answer, and profiles already in
    the user's temporal.toml (which is where Temporal Cloud credentials live).
    Neither is fatal if it comes back empty.
    """
    addresses = [str(a) for a in (spec.get("addresses") or []) if str(a).strip()]

    grpc = []
    if addresses:
        with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(addresses))) as pool:
            grpc = list(pool.map(lambda a: probe_address(spec, a), addresses))

    profiles = []
    try:
        listed = run({"cli": spec.get("cli")}, ["config", "list"]) or []
        for item in listed:
            name = (item or {}).get("name") or ""
            if not name:
                continue
            detail = {}
            try:
                detail = run({"cli": spec.get("cli"), "profile": name}, ["config", "get"]) or {}
            except CliError:
                pass
            profiles.append({
                "name": name,
                "address": detail.get("address") or "",
                "namespace": detail.get("namespace") or "",
            })
    except CliError:
        # No config file yet is the normal case, not an error worth surfacing.
        profiles = []

    return {"ok": True, "cliAvailable": True, "grpc": grpc, "profiles": profiles}


MODES = {
    "poll": mode_poll,
    "discover": mode_discover,
    "workflow": mode_workflow,
    "taskqueue": mode_taskqueue,
    "namespace": mode_namespace,
}


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else "-"
    if raw == "-":
        raw = sys.stdin.read()

    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as err:
        print(json.dumps({"ok": False, "error": f"bad spec: {err}"}))
        return 0

    cli = str(spec.get("cli") or "temporal")
    if not shutil.which(cli) and str(spec.get("mode") or "poll") == "discover":
        print(json.dumps({"ok": True, "cliAvailable": False, "grpc": [], "profiles": []}))
        return 0
    if not shutil.which(cli):
        # Named explicitly rather than left as a generic failure: "not installed"
        # is a fixable problem and the panel should be able to say so.
        print(json.dumps({"ok": False, "error": f"{cli} is not installed or not on PATH"}))
        return 0

    handler = MODES.get(str(spec.get("mode") or "poll"))
    if handler is None:
        print(json.dumps({"ok": False, "error": f"unknown mode: {spec.get('mode')}"}))
        return 0

    try:
        print(json.dumps(handler(spec)))
    except CliError as err:
        print(json.dumps({"ok": False, "error": str(err)}))
    except Exception as err:  # never let the panel see a traceback on stdout
        print(json.dumps({"ok": False, "error": f"{type(err).__name__}: {err}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

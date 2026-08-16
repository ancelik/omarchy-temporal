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

    collect.py -                  # spec on stdin -- the only form that keeps
                                  # credentials off the command line
    collect.py @OMT_SPEC          # spec in the named environment variable
    collect.py '<spec json>'      # legacy; do not use with credentials

Spec:

    {"mode": "poll",  "address": "localhost:7233", "namespaces": [...],
     "recentLimit": 25, "timeoutSec": 20, "cli": "temporal",
     "profile": "", "apiKey": "", "headers": {"CF-Access-Client-Id": "..."},
     "tlsCertPath": "", "tlsKeyPath": "", "tlsCaPath": "", "tlsServerName": "",
     "tlsDisableHostVerification": false, "tls": null}

Modes: poll, workflow, taskqueue, namespace, discover.
Every mode prints {"ok": true, ...} or {"ok": false, "error": "..."}.

Secrets never reach a command line. /proc/<pid>/cmdline is world readable, so
an api key passed as `--api-key` is visible to every user on the machine for as
long as the process lives -- and this program starts one `temporal` per
namespace per poll. Both the spec coming in and the credentials going out to
`temporal` travel by stdin and environment instead; /proc/<pid>/environ is
readable only by the owner. The `--grpc-meta` flag is the one exception, used
only for header names that cannot be spelled as an environment variable.
"""

import json
import os
import re
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

    Nothing secret is built here. TLS *paths* are not secrets -- the key they
    point at is, and it never leaves the file -- so those stay as flags, which
    is also the only way the CLI accepts them.
    """
    args = []
    profile = str(spec.get("profile") or "").strip()
    if profile:
        args += ["--profile", profile]
    elif spec.get("address"):
        args += ["--address", str(spec["address"])]

    for flag, key in (
        ("--tls-cert-path", "tlsCertPath"),
        ("--tls-key-path", "tlsKeyPath"),
        ("--tls-ca-path", "tlsCaPath"),
        ("--tls-server-name", "tlsServerName"),
    ):
        value = str(spec.get(key) or "").strip()
        if value:
            args += [flag, value]

    if spec.get("tlsDisableHostVerification"):
        args += ["--tls-disable-host-verification"]

    # `temporal` turns TLS on by itself as soon as an api key or any TLS option
    # is present, which is right for a real deployment and wrong for a proxy on
    # localhost that speaks cleartext. `"tls": false` is the way out of that,
    # and it is only ever passed when the config says so explicitly.
    if spec.get("tls") is True:
        args += ["--tls"]
    elif spec.get("tls") is False:
        args += ["--tls=false"]

    # Header names that are not a legal environment variable suffix have no env
    # form, so they go on the command line -- visible in `ps`. Almost nothing
    # hits this: the proxy headers people actually use are all plain words and
    # dashes. AUTH.md says so out loud rather than leaving it to be discovered.
    for name, value in sorted(header_items(spec)):
        if not ENV_SAFE_HEADER.match(name):
            args += ["--grpc-meta", "%s=%s" % (name, value)]

    return args


ENV_SAFE_HEADER = re.compile(r"^[A-Za-z0-9_-]+$")


def header_items(spec):
    """The custom headers from the spec, as (name, value) pairs."""
    headers = spec.get("headers") or {}
    if not isinstance(headers, dict):
        return []
    out = []
    for name, value in headers.items():
        name = str(name or "").strip()
        if name:
            out.append((name, str("" if value is None else value)))
    return out


def connection_env(spec):
    """The credentials, as environment rather than argv.

    `temporal --help` documents both of these: --api-key is also read from
    TEMPORAL_API_KEY, and --grpc-meta KEY=VALUE from TEMPORAL_GRPC_META_[name]
    with underscores standing in for the dashes a variable name cannot contain.
    Verified against the wire: the same header comes out either way.
    """
    env = dict(os.environ)

    api_key = str(spec.get("apiKey") or "")
    if api_key:
        env["TEMPORAL_API_KEY"] = api_key

    for name, value in header_items(spec):
        if ENV_SAFE_HEADER.match(name):
            # Upper cased, because that is the spelling checked against the
            # wire. HTTP/2 lower cases header names anyway, so normalizing the
            # variable name costs nothing and keeps the mapping predictable.
            env["TEMPORAL_GRPC_META_" + name.replace("-", "_").upper()] = value

    return env


def secrets_of(spec):
    """Every value in the spec that must never appear in output."""
    out = []
    api_key = str(spec.get("apiKey") or "")
    if api_key:
        out.append(api_key)
    for _, value in header_items(spec):
        if len(value) >= 8:
            out.append(value)
    return out


REDACTED = "\u2022\u2022\u2022\u2022"


def redact(text, secrets):
    """Blank anything secret out of text on its way to the panel.

    Belt and braces: the CLI is not supposed to echo credentials into its
    errors, but a Go client printing the metadata it sent is exactly the kind of
    thing that shows up in a stack trace one release later.
    """
    out = str(text or "")
    for secret in secrets:
        if len(secret) >= 8:
            out = out.replace(secret, REDACTED)
    out = re.sub(r"(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}", r"\1" + REDACTED, out)
    out = re.sub(r"(--api-key[= ])[^\s'\"]{8,}", r"\1" + REDACTED, out)
    return out


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
            env=connection_env(spec),
        )
    except FileNotFoundError:
        raise CliError(f"{cli} not found on PATH")
    except subprocess.TimeoutExpired:
        raise CliError("temporal timed out")

    if proc.returncode != 0:
        raise CliError(clean_error(proc.stderr or proc.stdout, secrets_of(spec)))

    text = (proc.stdout or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise CliError("unreadable temporal output")


def clean_error(text, secrets=()):
    """Reduce a CLI error to the one line worth putting in a bar panel.

    Model.classifyError reads this line to decide whether it means "expired
    token" or "unreachable", so the wording the CLI chose is kept intact rather
    than paraphrased -- only trimmed, and stripped of anything secret.
    """
    text = redact(text, secrets)
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
    fallback = [str(n) for n in (spec.get("fallbackNamespaces") or []) if str(n).strip()]

    namespace_list_error = None
    if pinned:
        names, namespaces_payload = pinned, None
    else:
        namespaces_payload = None
        names = []
        try:
            namespaces_payload = run(spec, ["operator", "namespace", "list"])
        except CliError as err:
            # ListNamespaces is a cluster-level call, so a credential scoped to
            # two namespaces can read both of them and still be refused it.
            # Failing the whole server for that would hide data the token is
            # entitled to. The caller decides what to fall back to and passes it
            # in; reporting the error alongside is what lets the panel say the
            # list on screen is a fallback rather than the truth.
            if not fallback:
                raise
            namespace_list_error = str(err)
            names = list(fallback)

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
        "namespaceListError": namespace_list_error,
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
    """Read the spec from wherever it was put, and never from a place that leaks.

    Stdin is what the plugin uses. `@NAME` reads the named environment variable,
    for callers that cannot write to a pipe. A spec passed as an argument still
    works because scripts and this file's own documentation have always shown
    that form -- but it is on the command line, so it is only safe when the spec
    has no credentials in it.
    """
    raw = sys.argv[1] if len(sys.argv) > 1 else "-"
    if raw == "-":
        raw = sys.stdin.read()
    elif raw.startswith("@"):
        raw = os.environ.get(raw[1:], "")
        if not raw:
            print(json.dumps({"ok": False, "error": f"{sys.argv[1][1:]} is empty or unset"}))
            return 0

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

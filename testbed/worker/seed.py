"""Keep the test-bed namespaces populated with a spread of execution statuses.

On boot this plants the long-lived executions (Running, Terminated, Canceled)
once per namespace, then loops forever starting short-lived ones so the plugin's
"recent workflows" list and running count keep moving.

SEED_TARGETS is a compact description of the whole fleet:

    host:port=ns1,ns2;host:port=ns3

so one seeder covers both servers without needing a container each.
"""

import asyncio
import json
import os
import random
import urllib.error
import urllib.request
from datetime import timedelta

from temporalio.client import Client
from temporalio.service import RPCError

from workflows import (
    TASK_QUEUE,
    CancellableWorkflow,
    FlakyWorkflow,
    GreetingWorkflow,
    OrderWorkflow,
    RetryWorkflow,
    SlowWorkflow,
    TimeoutWorkflow,
)

SEED_INTERVAL = int(os.environ.get("SEED_INTERVAL", "60"))
NAMES = ["ada", "grace", "alan", "edsger", "barbara", "linus", "ken"]


def parse_targets(raw: str) -> list[tuple[str, list[str]]]:
    targets = []
    for group in raw.split(";"):
        group = group.strip()
        if not group:
            continue
        address, _, namespaces = group.partition("=")
        names = [ns.strip() for ns in namespaces.split(",") if ns.strip()]
        targets.append((address.strip(), names or ["default"]))
    return targets


async def start(client: Client, workflow, arg: str, wid: str, **kwargs):
    """Start one execution, tolerating the id already being in use.

    Re-running the seeder against a persisted volume is expected, so a
    duplicate id is a no-op rather than an error.
    """
    try:
        return await client.start_workflow(
            workflow, arg, id=wid, task_queue=TASK_QUEUE, **kwargs
        )
    except Exception as err:  # WorkflowAlreadyStartedError and friends
        if "already" in str(err).lower():
            return None
        print(f"  ! start {wid}: {err}", flush=True)
        return None


async def seed_persistent(client: Client, namespace: str) -> None:
    """The executions that define the namespace's resting state.

    These are planted once. Running stays Running for an hour, and the
    terminated/cancelled pair give the panel closed executions that are neither
    Completed nor Failed.
    """
    for n in range(2):
        await start(client, SlowWorkflow, f"{namespace}-idle-{n}", f"slow-{namespace}-{n}")

    doomed = await start(
        client, SlowWorkflow, f"{namespace}-doomed", f"terminate-me-{namespace}"
    )
    if doomed:
        await asyncio.sleep(1)
        await doomed.terminate(reason="seeded terminated execution")
        print(f"  terminated terminate-me-{namespace}", flush=True)

    cancelled = await start(
        client, CancellableWorkflow, f"{namespace}-cancelled", f"cancel-me-{namespace}"
    )
    if cancelled:
        await asyncio.sleep(1)
        await cancelled.cancel()
        print(f"  cancelled cancel-me-{namespace}", flush=True)

    # A short execution timeout is what turns this into TimedOut rather than a
    # Failed execution that happens to mention a timeout.
    await start(
        client,
        TimeoutWorkflow,
        f"{namespace}-timeout",
        f"timeout-{namespace}",
        execution_timeout=timedelta(seconds=20),
    )

    # Never succeeds, and retries forever on a fixed interval. This is the one
    # that gives the Activity view something to say: a pending Activity with a
    # climbing attempt count, the last error, and the next retry time.
    await start(client, RetryWorkflow, f"billing-{namespace}", f"retry-{namespace}")

    # A cron keeps producing fresh Completed executions on its own, so the
    # boards stay alive even if the seeder loop is stopped.
    await start(
        client,
        GreetingWorkflow,
        "cron",
        f"cron-greeting-{namespace}",
        cron_schedule="* * * * *",
    )


async def seed_round(client: Client, namespace: str, round_no: int) -> None:
    """Short-lived executions, restarted every interval."""
    stamp = f"{namespace}-{round_no}"
    await start(client, GreetingWorkflow, random.choice(NAMES), f"greet-{stamp}")
    await start(client, OrderWorkflow, f"order-{stamp}", f"order-{stamp}")
    if round_no % 2 == 0:
        await start(client, FlakyWorkflow, "card expired", f"flaky-{stamp}")


async def create_schedule(client: Client, namespace: str) -> None:
    """A real Schedule, which is a different primitive from a cron Workflow.

    The cron above is a property of one execution; this is a first-class
    Schedule object with its own spec and future action times, and it is what
    the plugin's Schedules section reads.
    """
    from temporalio.client import (
        Schedule,
        ScheduleActionStartWorkflow,
        ScheduleIntervalSpec,
        ScheduleSpec,
    )

    try:
        await client.create_schedule(
            f"heartbeat-{namespace}",
            Schedule(
                action=ScheduleActionStartWorkflow(
                    GreetingWorkflow.run,
                    "scheduled",
                    id=f"scheduled-greet-{namespace}",
                    task_queue=TASK_QUEUE,
                ),
                spec=ScheduleSpec(
                    intervals=[ScheduleIntervalSpec(every=timedelta(seconds=45))]
                ),
            ),
        )
        print(f"  schedule heartbeat-{namespace}", flush=True)
    except Exception as err:
        if "already" not in str(err).lower():
            print(f"  ! schedule {namespace}: {err}", flush=True)


def start_batch_operation(http_base: str, namespace: str) -> None:
    """Leave one batch job behind so the Batch section is not perpetually empty.

    Neither the Python SDK nor `temporal batch` can start one, so this posts
    StartBatchOperation directly. The query deliberately matches nothing: the
    job completes instantly having touched zero executions, which is all that is
    needed to demonstrate the primitive without terminating real work.
    """
    job_id = f"omtemporal-demo-{namespace}"
    body = json.dumps({
        "jobId": job_id,
        "namespace": namespace,
        "reason": "omtemporal test bed demo (matches nothing)",
        "visibilityQuery": "WorkflowType = 'NoSuchWorkflowTypeExists'",
        "terminationOperation": {"identity": "omtemporal-seeder"},
    }).encode()

    url = f"{http_base}/api/v1/namespaces/{namespace}/batch-operations/{job_id}"
    request = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request, timeout=10).read()
        print(f"  batch job {job_id}", flush=True)
    except urllib.error.HTTPError as err:
        if err.code != 409:  # already exists on a re-run
            print(f"  ! batch {namespace}: {err.code}", flush=True)
    except Exception as err:
        print(f"  ! batch {namespace}: {err}", flush=True)


def http_base_for(address: str) -> str:
    """The test bed maps every server's HTTP API to 7243 inside its container."""
    host = address.split(":")[0]
    return f"http://{host}:7243"


async def connect(address: str, namespace: str) -> Client | None:
    for attempt in range(30):
        try:
            return await Client.connect(address, namespace=namespace)
        except (RPCError, RuntimeError, OSError) as err:
            if attempt == 29:
                print(f"  ! cannot reach {address}/{namespace}: {err}", flush=True)
                return None
            await asyncio.sleep(2)
    return None


async def main() -> None:
    targets = parse_targets(os.environ.get("SEED_TARGETS", "localhost:7233=default"))
    clients: list[tuple[str, str, Client]] = []

    for address, namespaces in targets:
        for namespace in namespaces:
            client = await connect(address, namespace)
            if client:
                clients.append((address, namespace, client))

    print(f"seeding {len(clients)} namespaces", flush=True)

    for address, namespace, client in clients:
        print(f"{address}/{namespace}: persistent set", flush=True)
        await seed_persistent(client, namespace)
        await create_schedule(client, namespace)
        start_batch_operation(http_base_for(address), namespace)

    round_no = 0
    while True:
        round_no += 1
        for address, namespace, client in clients:
            await seed_round(client, namespace, round_no)
        print(f"round {round_no} started across {len(clients)} namespaces", flush=True)
        await asyncio.sleep(SEED_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())

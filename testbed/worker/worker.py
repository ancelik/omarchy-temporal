"""Run one Temporal Worker per namespace, all on a single asyncio loop.

A Worker serves exactly one namespace, so covering several namespaces means
several Workers. Running them in one process (rather than one container each)
keeps the compose file from implying that these are separate machines.
"""

import asyncio
import os

from temporalio.client import Client
from temporalio.worker import Worker

from workflows import ALL_ACTIVITIES, ALL_WORKFLOWS, TASK_QUEUE

ADDRESS = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
NAMESPACES = [
    ns.strip()
    for ns in os.environ.get("TEMPORAL_NAMESPACES", "default").split(",")
    if ns.strip()
]


async def run_worker(namespace: str) -> None:
    client = await Client.connect(ADDRESS, namespace=namespace)
    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=ALL_WORKFLOWS,
        activities=ALL_ACTIVITIES,
    )
    print(f"worker up: {ADDRESS} ns={namespace} queue={TASK_QUEUE}", flush=True)
    await worker.run()


async def main() -> None:
    print(f"starting workers for {ADDRESS}: {', '.join(NAMESPACES)}", flush=True)
    await asyncio.gather(*(run_worker(ns) for ns in NAMESPACES))


if __name__ == "__main__":
    asyncio.run(main())

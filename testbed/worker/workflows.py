"""Sample workflows for the omtemporal test bed.

Between them these cover every execution status the bar plugin renders:
Running, Completed, Failed, TimedOut, Canceled and Terminated. Nothing here is
meant to be realistic — each one exists to park an execution in a particular
terminal state, cheaply and predictably.
"""

import asyncio
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

TASK_QUEUE = "omtemporal"


# --- activities -------------------------------------------------------------


@activity.defn
async def say_hello(name: str) -> str:
    return f"Hello, {name}!"


@activity.defn
async def charge_card(order_id: str) -> str:
    await asyncio.sleep(3)
    return f"charged {order_id}"


@activity.defn
async def pack_order(order_id: str) -> str:
    await asyncio.sleep(5)
    return f"packed {order_id}"


@activity.defn
async def ship_order(order_id: str) -> str:
    await asyncio.sleep(4)
    return f"shipped {order_id}"


@activity.defn
async def always_fails(reason: str) -> str:
    # Non-retryable so the workflow reaches Failed on the first attempt instead
    # of sitting in Running through a retry backoff.
    raise ApplicationError(f"payment declined: {reason}", non_retryable=True)


@activity.defn
async def keeps_failing(target: str) -> str:
    # Retryable, unlike always_fails. The point is the retry loop itself: it
    # parks a pending Activity with a climbing attempt count and a last-failure
    # message, which is exactly what the plugin's Activity view exists to show.
    attempt = activity.info().attempt
    raise ApplicationError(f"cannot reach {target} (attempt {attempt})")


# --- workflows ---------------------------------------------------------------


@workflow.defn
class GreetingWorkflow:
    """Completes in about a second. The bulk of the Completed executions."""

    @workflow.run
    async def run(self, name: str) -> str:
        return await workflow.execute_activity(
            say_hello, name, start_to_close_timeout=timedelta(seconds=10)
        )


@workflow.defn
class OrderWorkflow:
    """A few chained activities, ~12s end to end.

    Long enough to be caught mid-flight in the panel, short enough to keep
    turning over into Completed while you watch.
    """

    @workflow.run
    async def run(self, order_id: str) -> str:
        await workflow.execute_activity(
            charge_card, order_id, start_to_close_timeout=timedelta(seconds=30)
        )
        await workflow.execute_activity(
            pack_order, order_id, start_to_close_timeout=timedelta(seconds=30)
        )
        return await workflow.execute_activity(
            ship_order, order_id, start_to_close_timeout=timedelta(seconds=30)
        )


@workflow.defn
class SlowWorkflow:
    """Sleeps for an hour, so it just sits there as Running.

    Also the seeder's terminate target — a workflow that will not finish on its
    own is the only honest way to demonstrate a Terminated execution.
    """

    @workflow.run
    async def run(self, label: str) -> str:
        await workflow.sleep(timedelta(hours=1))
        return f"finally done: {label}"


@workflow.defn
class FlakyWorkflow:
    """Fails on purpose."""

    @workflow.run
    async def run(self, reason: str) -> str:
        return await workflow.execute_activity(
            always_fails,
            reason,
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@workflow.defn
class TimeoutWorkflow:
    """Outlives its execution timeout.

    The timeout is set by the caller (seed.py passes execution_timeout), which
    is what produces WORKFLOW_EXECUTION_STATUS_TIMED_OUT rather than a Failed
    execution carrying a timeout cause.
    """

    @workflow.run
    async def run(self, label: str) -> str:
        await workflow.sleep(timedelta(minutes=10))
        return f"never gets here: {label}"


@workflow.defn
class RetryWorkflow:
    """Never finishes, because its Activity never succeeds.

    Unlimited retries on a fixed 15s interval, so at any moment there is a
    pending Activity mid-backoff to look at: attempt N, the last error, and the
    time of the next try.
    """

    @workflow.run
    async def run(self, target: str) -> str:
        return await workflow.execute_activity(
            keeps_failing,
            target,
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(
                initial_interval=timedelta(seconds=15),
                backoff_coefficient=1.0,
                maximum_attempts=0,
            ),
        )


@workflow.defn
class CancellableWorkflow:
    """Sleeps until cancelled.

    The CancelledError is deliberately left to propagate: that is what closes
    the execution as Canceled instead of Completed.
    """

    @workflow.run
    async def run(self, label: str) -> str:
        await workflow.sleep(timedelta(minutes=30))
        return f"not cancelled after all: {label}"


ALL_WORKFLOWS = [
    GreetingWorkflow,
    OrderWorkflow,
    SlowWorkflow,
    FlakyWorkflow,
    TimeoutWorkflow,
    RetryWorkflow,
    CancellableWorkflow,
]

ALL_ACTIVITIES = [say_hello, charge_card, pack_order, ship_order, always_fails, keeps_failing]

# Test bed

Two independent Temporal servers, six namespaces, and workers that keep every
Workflow Execution status populated — enough to exercise the plugin's
multi-server aggregation, its namespace discovery, and its per-server failure
handling without pointing it at anything real.

```bash
docker compose up -d --build
```

| | gRPC | HTTP API | Web UI | Namespaces |
|---|---|---|---|---|
| `temporal-a` | 7233 | 7243 | http://localhost:8233 | `default`, `payments`, `orders` |
| `temporal-b` | 7234 | 7244 | http://localhost:8234 | `default`, `staging`, `analytics` |

Point the plugin at both by putting this on its entry in
`~/.config/omarchy/shell.json`:

```json
"servers": [
  { "label": "local",   "url": "http://localhost:7243", "uiUrl": "http://localhost:8233" },
  { "label": "staging", "url": "http://localhost:7244", "uiUrl": "http://localhost:8234" }
]
```

## Testing authentication

`temporal server start-dev` **cannot enforce authentication**. There is no
`--authorizer` and no `--config` — both are rejected outright — and it ignores
the `TEMPORAL_AUTH_*` variables the full server distribution reads: ask it to
print its own config and `authorizer` comes back empty. An unauthenticated
request and one carrying `Authorization: Bearer totally-fake` both return `200`.

So `authproxy.py` sits in front of `temporal-a` instead, which is also the
topology the feature is for: self-hosted Temporal behind Cloudflare Access, an
ingress or an oauth2-proxy. It is behind a compose profile, so the default
`docker compose up` is unchanged.

```bash
docker compose --profile auth up -d authproxy
node ../testbed/parity-test.mjs        # the auth section runs when it is up
```

| | Port | Requires |
|---|---|---|
| `authproxy` → `temporal-a` | 7253 | `Authorization: Bearer s3cret-token-value`, plus `CF-Access-Client-Id: cf-client-id` and `CF-Access-Client-Secret: cf-client-secret` |

It refuses `ListNamespaces` with a `403` even for a valid token, which is how a
namespace-scoped credential really behaves and what the plugin's namespace
fallback exists for. To point the plugin at it:

```json
{
  "label": "proxied",
  "url": "http://localhost:7253",
  "uiUrl": "http://localhost:8233",
  "namespaces": ["orders", "payments"],
  "apiKeyCommand": "printf s3cret-token-value",
  "headers": {
    "CF-Access-Client-Id": "cf-client-id",
    "CF-Access-Client-Secret": "cf-client-secret"
  }
}
```

Change `TOKEN` on the service to watch the panel report a rejected token, and
`DENY_LIST=0` to turn the namespace refusal off.

## What runs in there

`worker.py` hosts one Worker per namespace on a single asyncio loop (a Worker
serves exactly one namespace, and one container per namespace would imply
these are separate machines when they are not).

`seed.py` plants a persistent set per namespace on boot, then starts more
short-lived executions every `SEED_INTERVAL` seconds so the recent-executions
list and the running count keep moving while you watch.

| Workflow | Ends up as |
|---|---|
| `GreetingWorkflow` | Completed (also runs on a `* * * * *` cron) |
| `OrderWorkflow` | Running for ~12s, then Completed |
| `SlowWorkflow` | Running — sleeps an hour |
| `FlakyWorkflow` | Failed — non-retryable, so it fails on the first attempt |
| `TimeoutWorkflow` | TimedOut — the caller sets a 20s execution timeout |
| `RetryWorkflow` | Running forever, with an Activity that retries every 15s |
| `CancellableWorkflow` | Canceled — the seeder cancels it |
| `SlowWorkflow` (one instance) | Terminated — the seeder terminates it |

`RetryWorkflow` is the one that matters for the Activity view: its Activity
never succeeds, so there is always a pending Activity mid-backoff to look at,
with a climbing attempt count, the last error, and the next retry time.

Each namespace also gets:

- a **Schedule** (`heartbeat-<ns>`, every 45s) — a first-class Schedule object,
  which is a different primitive from the cron above
- a **batch operation** (`omtemporal-demo-<ns>`), started over the HTTP API with
  a query that deliberately matches nothing, so the Batch section has something
  real to show without terminating any actual work

## Parity test

The plugin uses one set of parsers for both the HTTP API and the CLI. This
asserts the two really do agree, against the live test bed:

```bash
node testbed/parity-test.mjs
```

It also covers the entry builders — that each level yields one kind of thing,
that a task queue with no workers is flagged urgent, and that both `servers`
config forms read back the same.

## Checking it by hand

```bash
curl -s localhost:7243/api/v1/namespaces | jq -r '.namespaces[].namespaceInfo.name'

# Grouped counts come back as base64 protobuf payloads
curl -s -G localhost:7243/api/v1/namespaces/orders/workflow-count \
  --data-urlencode 'query=GROUP BY ExecutionStatus' \
  | jq -r '.groups[] | "\(.groupValues[0].data|@base64d)\t\(.count)"'
```

## Exercising the failure path

```bash
docker compose stop temporal-b     # panel marks it unreachable, keeps showing A
docker compose start temporal-b    # recovers within a poll or two
```

Give it ~20s after `start`: the container reports healthy before the HTTP
listener is actually answering.

## Two things worth knowing

**Bind mounts, not named volumes.** The image runs as uid 1000, and a fresh
named volume lands root-owned — which SQLite reports as the deeply unhelpful
`unable to open database file: out of memory (14)`. The host user is also uid
1000, so `./data/a` just works. `data/` is gitignored.

**Worker heartbeats are not emitted** by the Python SDK, so the `/workers`
endpoint only ever reports Temporal's own internal worker. Task-queue pollers
are the reliable answer to "is anything listening", which is what the plugin
uses.

**`ORDER BY` is not supported** by the SQLite visibility store the dev server
uses; it returns `operation is not supported`. Results already arrive
newest-first, and the plugin re-sorts client side.

## Tear down

```bash
docker compose down          # keeps ./data
docker compose down && rm -rf data   # start clean
```

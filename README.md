# Temporal for Omarchy

Your Temporal fleet in the [Omarchy](https://omarchy.org) bar — servers,
namespaces, workflows, activities, task queues and schedules, each shown as its
own kind of thing, arranged the way they actually nest.

The bar shows how many Workflow Executions are running and how many have failed
recently. Clicking opens a panel you drill down through:

```
Servers  ›  local  ›  orders  ›  retry-orders
                                 ⚡ keeps_failing
                                   cannot reach billing-orders (attempt 7)
                                   Scheduled · retry in 7s
```

It is **read-only**. Nothing here can cancel, terminate, signal or reset a
Workflow — the only outbound action is opening a page in your browser.

## Install

```bash
omarchy plugin add https://github.com/ancelik/omarchy-temporal.git --enable
```

Then open the widget. With nothing configured it opens on a setup screen that
looks for servers on this machine and reads any profiles in your
`temporal.toml`, and adds one on a keystroke. Or from a terminal:

```bash
omtemporal setup
```

## The primitives

Each level of the panel shows exactly one kind of thing, with its own glyph and
a one-line explanation of what it is. That is the point: a namespace and a task
queue are not the same sort of object, and a list that mixes them teaches you
nothing.

| Level | Shows | Answers |
|---|---|---|
| **Servers** | every configured server, version, reachability | what am I connected to |
| **Server** | its cluster (version, persistence and visibility stores) and its namespaces | what lives on this one |
| **Namespace** | retention, task queues, schedules, batch operations, executions | what is going on in here |
| **Workflow** | the execution, plus its **pending activities** — attempt count, last failure, next retry | why is this one stuck |
| **Task queue** | the workers polling each side of it, and the backlog | is anything actually listening |

The task-queue level is the one to reach for when work stops moving. Temporal
will happily accept executions onto a queue nobody is polling, and this is the
only view that says so out loud.

## Transports

Each server is reached one of two ways, chosen explicitly per server.

| | `http` | `cli` |
|---|---|---|
| How | Temporal's HTTP API, straight from the shell | shells out to `temporal … -o json` |
| Needs | `httpPort` enabled server-side | the `temporal` CLI on PATH |
| Speed | fast; polls as often as you like | a process start per poll, so no faster than 15s |
| Auth | API keys, bearer tokens, custom headers | all of that, plus mTLS, `temporal.toml` profiles and Temporal Cloud |

Prefer `http` where it is available. Reach for `cli` when the HTTP listener is
off — which is the default for most real deployments — when the connection needs
client certificates, which the shell's HTTP client cannot present, or for
Temporal Cloud, which publishes no HTTP API. A server configured with a client
certificate is moved onto `cli` automatically and told you so.

See [AUTH.md](AUTH.md) for every mechanism, which transport each needs, and
worked examples including Temporal Cloud and mTLS.

Both go through the same parsers, so the two render identically.
`testbed/parity-test.mjs` exists to keep that true.

## Configuring

The setup screen and `omtemporal` both write for you. To edit by hand, the
widget's entry lives in `~/.config/omarchy/shell.json`:

```json
{
  "id": "com.anilcelik.temporal",
  "refreshIntervalSec": 30,
  "servers": [
    { "label": "local", "url": "http://localhost:7243", "uiUrl": "http://localhost:8233" },
    { "label": "prod",  "transport": "cli", "profile": "prod", "namespaces": ["payments"] }
  ]
}
```

| Key | Meaning |
|---|---|
| `label` | Name shown in the panel. Defaults to the host. |
| `transport` | `http` or `cli`. Inferred from which address you give. |
| `url` | HTTP API base, for `http`. `/api/v1` and `http://` are filled in if missing. |
| `address` | gRPC `host:port`, for `cli`. |
| `profile` | A profile name from `temporal.toml`, for `cli`. Brings its own address, credentials and TLS. |
| `uiUrl` | Web UI base, used to build links. Falls back to `url`. |
| `namespaces` | Pin the namespaces to poll. Omit to discover them. Also the way to work with a credential that cannot call `ListNamespaces`. |
| `apiKey` | Bearer token, inline. Works, warns — `shell.json` is not a secret store. |
| `apiKeyCommand` | Shell command whose stdout is the token. The preferred way: `pass`, `gopass`, `secret-tool`, `op`. |
| `apiKeyTtlSec` | How long a resolved token is reused before the command runs again. Default 900. `0` resolves once and keeps it. |
| `headers` | Extra headers on every request, as a map or as `"Name: value"` lines. For Cloudflare Access and friends. |
| `tls` | Force base TLS on or off (`cli`). Omit to let the CLI decide — it turns TLS on by itself when an API key is present. |
| `tlsCertPath` | Client certificate (`cli`). Its presence moves the server onto the `cli` transport. |
| `tlsKeyPath` | The certificate's key (`cli`). Required alongside `tlsCertPath`. |
| `tlsCaPath` | CA to verify the server with (`cli`). |
| `tlsServerName` | Override the expected TLS server name (`cli`). |
| `tlsDisableHostVerification` | Skip checking the server's identity (`cli`). Warned about. |

Credentials never reach a command line: the collector spec goes in on stdin and
`temporal` gets its key from the environment. See
[Secrets and argv](AUTH.md#secrets-and-argv).

> **You may see `"servers": {"list": [...]}`.** That is what the setup screen
> writes. The shell's `setBarWidget` IPC silently drops a setting whose value is
> a bare JSON array, but preserves the identical array nested in an object. Both
> forms are read the same way, so a hand-written plain array keeps working.

### Widget settings

| Setting | Default | Meaning |
|---|---|---|
| `refreshIntervalSec` | 30 | Poll interval while the panel is closed |
| `openRefreshIntervalSec` | 5 | Poll interval while it is open |
| `recentLimit` | 25 | Executions fetched per namespace |
| `requestTimeoutSec` | 8 | When a server is declared unreachable |
| `hideWhenIdle` | false | Hide the widget when nothing is running |
| `cliPath` | `temporal` | Path to the CLI, if it is not on PATH |

Deep data — activities, pollers, schedules, batch operations — is fetched when
you drill into it, not polled for every namespace. A six-namespace fleet costs
two requests per namespace per tick, not twenty.

## Using it

| Bar | |
|---|---|
| Left click | Open the panel |
| Right click | Refresh now |
| Middle click | Open the Web UI |

| Key | Action |
|---|---|
| `j` / `k`, arrows | Move the cursor |
| `enter`, `l` | Go in |
| `esc`, `h` | Go back — closes the panel at the top |
| `f` | Cycle the filter: all → running → needs attention |
| `r` | Refresh this level |
| `o` | Open what you are looking at in the Web UI |
| `s` | Servers / setup |

Breadcrumbs are clickable, so you can jump back several levels at once.

## Command line

```bash
omtemporal setup                              # interactive picker
omtemporal list                               # configured servers
omtemporal add http://localhost:7243 local    # HTTP
omtemporal add localhost:7233                 # gRPC, via the CLI
omtemporal add profile:prod                   # a temporal.toml profile
omtemporal add https://temporal.corp:7243 prod apiKeyCommand='pass temporal/prod'
omtemporal remove local
omtemporal status
omtemporal doctor                             # why is the widget empty
omtemporal open namespace 0 orders            # jump straight to a level
```

`add` and `remove` call into the running widget, so the terminal and the panel
share one implementation and cannot drift apart.

`omtemporal doctor` is the first thing to run when something looks wrong: it
checks the shell, the widget, the CLI, every server's reachability, whether each
HTTP server's API is actually enabled — and, since that is now the leading cause
of an empty panel, its credentials. What each server carries, anything already
known to be wrong with the way it is configured, whether the certificates it
names exist and are readable, and whether the key command runs. It reports how
many characters the command produced, never the token.

`omtemporal open` is useful as a keybind — point it at the namespace you care
about and skip the drilling.

## Two different failure counts, on purpose

The **panel** shows each namespace's lifetime totals from
`CountWorkflowExecutions` — the true number of failed executions it has ever
accumulated.

The **bar** counts only failures inside the recent window. A namespace that
failed something last Tuesday would otherwise pin the widget to its urgent
colour forever, which trains you to ignore it. The bar answers "is something
going wrong now?"; the panel answers "how much has gone wrong here?".

## IPC

```bash
omarchy-shell temporal toggle
omarchy-shell temporal refresh
omarchy-shell temporal status
omarchy-shell temporal servers      # per-server reachability
omarchy-shell temporal auth         # per-server credentials, for doctor
omarchy-shell temporal openAt '{"level":"namespace","serverIndex":0,"namespace":"orders"}'
```

## Development

`testbed/` brings up two Temporal servers with six namespaces between them and
workers that keep every primitive populated — including a Workflow whose
Activity retries forever, so the Activity view always has something to show. See
[testbed/README.md](testbed/README.md).

```bash
bin/dev-install               # validate, copy into ~/.config/omarchy/plugins/, rescan
node testbed/parity-test.mjs  # assert HTTP and CLI parse identically

# An authenticating front door, for the 401/403 and namespace-fallback paths.
# `temporal server start-dev` cannot enforce anything, so a proxy stands in.
docker compose -f testbed/compose.yaml --profile auth up -d authproxy
```

Saving a file under `~/.config/omarchy/plugins/` hot-reloads plugin QML, but the
QML engine caches imported `.js` files and does not always pick up changes to
IPC handlers — after editing `Model.js` or adding an IPC method, run
`omarchy-restart-shell`. Errors go to the shell's journal:

```bash
journalctl --user -f | grep com.anilcelik.temporal
```

### Layout

| File | Role |
|---|---|
| `Panel.qml` | Bar button, router, breadcrumb, keys |
| `Service.qml` | Both transports, poll lifecycle, on-demand detail fetches |
| `Model.js` | Parsing, rollups, formatting, and the entry builders that decide what each level contains |
| `EntryList.qml` / `PrimitiveRow.qml` | The one renderer every level uses |
| `SetupView.qml` | Discovery, onboarding, persistence |
| `AUTH.md` | Every credential the plugin can present, and where to keep it |
| `collect.py` | CLI transport — runs `temporal`, returns raw payloads for `Model.js` to parse |
| `TemporalIcon.qml` | The mark, drawn on a Canvas so it stays sharp at bar sizes |

Levels are not separate files on purpose. Each one is a list of entries built by
a function in `Model.js` and drawn by `EntryList`, which is what keeps a
namespace looking like a namespace everywhere it appears — and makes the entry
builders testable without a running shell.

## Limits

- **mTLS needs the `cli` transport.** QML's `XMLHttpRequest` cannot present a
  client certificate, so a server configured with one is moved onto `cli`.
- **Temporal Cloud needs the `cli` transport.** Cloud publishes no documented
  HTTP API; see [AUTH.md](AUTH.md#temporal-cloud--cli-transport-only).
- **Standalone Activities are not shown.** The API exposes them, but the
  Activity view is built on `pendingActivities` from a Workflow description,
  which is the one that answers why something is stuck.
- **Batch operations are listed, not started.** Neither the Python SDK nor
  `temporal batch` can start one.

## License

MIT

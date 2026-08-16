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
| Auth | API keys and bearer tokens | whatever the CLI supports, including mTLS and Temporal Cloud profiles |

Prefer `http` where it is available. Reach for `cli` when the HTTP listener is
off — which is the default for most real deployments — or when the connection
needs client certificates, which the shell's HTTP client cannot present.

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
| `namespaces` | Pin the namespaces to poll. Omit to discover them. Also the way to work with a token that cannot call ListNamespaces. |
| `apiKey` | Sent as `Authorization: Bearer`. |
| `apiKeyCommand` | Shell command whose stdout is the key, run once per session — keeps tokens out of `shell.json`. |

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
omtemporal remove local
omtemporal status
omtemporal doctor                             # why is the widget empty
omtemporal open namespace 0 orders            # jump straight to a level
```

`add` and `remove` call into the running widget, so the terminal and the panel
share one implementation and cannot drift apart.

`omtemporal doctor` is the first thing to run when something looks wrong: it
checks the shell, the widget, the CLI, every server's reachability, and whether
each HTTP server's API is actually enabled.

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
| `collect.py` | CLI transport — runs `temporal`, returns raw payloads for `Model.js` to parse |
| `TemporalIcon.qml` | The mark, drawn on a Canvas so it stays sharp at bar sizes |

Levels are not separate files on purpose. Each one is a list of entries built by
a function in `Model.js` and drawn by `EntryList`, which is what keeps a
namespace looking like a namespace everywhere it appears — and makes the entry
builders testable without a running shell.

## Limits

- **mTLS needs the `cli` transport.** QML's `XMLHttpRequest` cannot present a
  client certificate.
- **Standalone Activities are not shown.** The API exposes them, but the
  Activity view is built on `pendingActivities` from a Workflow description,
  which is the one that answers why something is stuck.
- **Batch operations are listed, not started.** Neither the Python SDK nor
  `temporal batch` can start one.

## Branding

The mark is Temporal's own symbol — the path from their published
`Temporal_Symbol` SVG, converted to beziers and drawn on a Canvas so it stays
sharp at bar sizes and can take the theme's colour. It is reproduced faithfully,
including the merge at the lower-right crossing that makes the mark subtly
asymmetric (that is in Temporal's own PNG export too, so it is the mark rather
than an export artefact).

By default the mark is drawn in your Omarchy theme's foreground colour, and in
the theme's urgent colour when something needs attention. That is a deliberate
departure from painting it Temporal's brand indigo: an Omarchy bar is themed end
to end, a widget that ignores the active theme looks broken next to every other
icon, and a mark that stays branded while the fleet is on fire is worse than one
that turns red. Set `brandColor: true` to use Temporal's primary brand colour,
**UV `#444CE7`**, when nothing is wrong.

Temporal is a trademark of Temporal Technologies, Inc. This plugin is
unofficial, is not affiliated with or endorsed by Temporal, and uses the mark
only to identify the product it monitors. Brand assets and guidelines:
<https://temporal.io/brand>.

## License

MIT

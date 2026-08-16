# Authentication

Every real Temporal deployment wants something from you before it will answer.
This is what this plugin can present, which transport can present it, and where
the secret should live.

The short version:

| You have | Transport | How |
|---|---|---|
| Nothing (a dev server) | `http` | nothing to do |
| An API key / bearer token | `http` or `cli` | `apiKeyCommand` |
| A client certificate (mTLS) | **`cli` only** | `tlsCertPath` + `tlsKeyPath` |
| Proxy headers (Cloudflare Access, oauth2-proxy) | `http` or `cli` | `headers` |
| Temporal Cloud | **`cli` only** | `address` + `apiKeyCommand`, or mTLS |
| A `temporal.toml` profile | `cli` only | `profile` |

`apiKeyCommand` is the right answer to "where do I put the token". Everything
else in this document is about the cases it does not cover.

---

## Where secrets should live

In descending order of how much this plugin recommends them.

### 1. A `temporal.toml` profile — `cli` transport

The `temporal` CLI keeps profiles in `~/.config/temporalio/temporal.toml`, and
writes that file with mode `0600`. The API key, custom gRPC headers and TLS
paths all live in it, so nothing this plugin does ever touches the secret at
all — it passes a profile name and the CLI reads its own file.

```toml
[profile]
  [profile.prod]
    address = "orders.a1b2c.tmprl.cloud:7233"
    namespace = "orders.a1b2c"
    api_key = "…"
    [profile.prod.grpc_meta]
      cf-access-client-id = "…"
    [profile.prod.tls]
      client_cert_path = "/home/you/certs/client.pem"
      client_key_path = "/home/you/certs/client.key"
```

```bash
omtemporal add profile:prod
```

```json
{ "label": "prod", "transport": "cli", "profile": "prod" }
```

A profile carries its own address, so the plugin does not send `--address`
alongside it — that would override the one thing the profile exists to supply.

### 2. `apiKeyCommand` — either transport

A shell command whose stdout is the token. Works with everything:

```json
{ "apiKeyCommand": "pass show temporal/prod" }
{ "apiKeyCommand": "gopass show -o temporal/prod" }
{ "apiKeyCommand": "secret-tool lookup service temporal env prod" }
{ "apiKeyCommand": "op read op://Work/temporal-prod/credential" }
{ "apiKeyCommand": "cat ~/.config/temporal/token" }
```

Trailing whitespace is stripped. The command runs under `bash -lc`, so your
login `PATH` and shell functions are available.

**It is re-run.** Tokens expire — an hour is a common lifetime — and resolving
once per shell session meant a panel that worked all morning and was full of red
by lunchtime. The command is re-run when its result ages past `apiKeyTtlSec`
(default 900 seconds), and once more when a server rejects the token it
produced. A rejection cannot trigger more than one re-run per poll, and no more
than one per minute per server, so a credential that is simply wrong surfaces as
an error rather than turning into a password-manager prompt every thirty
seconds.

Set `apiKeyTtlSec: 0` to resolve once and keep it. Set it to something short if
your tokens are short-lived, remembering that every expiry is a process start
and possibly a passphrase prompt.

When it fails, `omtemporal doctor` says so — including whether it exited
non-zero, whether it printed nothing, and how many characters it produced. It
never prints the token.

### 3. `apiKey` — inline, discouraged

```json
{ "apiKey": "…" }
```

It works, and the plugin warns about it every time it lists the server, because
`~/.config/omarchy/shell.json` is not a secret store. Use it for a throwaway
token against a test deployment.

If both are set, the inline `apiKey` wins and you get a warning saying so.

---

## What goes on the wire

### API key / bearer token

**`http`** — sent as `Authorization: Bearer <key>`. Temporal's HTTP API passes
the `authorization` header straight through grpc-gateway to the same
interceptor the gRPC endpoint uses, so a key that works for one works for the
other.

**`cli`** — passed to `temporal` through the `TEMPORAL_API_KEY` environment
variable, not the `--api-key` flag. See [Secrets and argv](#secrets-and-argv).

One surprise: **an API key turns TLS on**. `temporal --help` says `--tls` "is
defaulted to true if api-key or any other TLS options are present", and it means
it — pointing a key at a cleartext dev server gets you

```
transport: authentication handshake failed: tls: first record does not look like a TLS handshake
```

which the panel reports as a TLS failure rather than an auth one. If you really
are talking to a plaintext listener with a key (a local tunnel, a test proxy),
say so:

```json
{ "transport": "cli", "address": "localhost:7233", "apiKeyCommand": "…", "tls": false }
```

### mTLS — `cli` transport only

**QML's `XMLHttpRequest` cannot present a client certificate.** There is no API
for it; the shell's HTTP client uses the system trust store and its own (absent)
client identity. This is a fact about the transport, not a missing feature here.

So an entry carrying `tlsCertPath` + `tlsKeyPath` is **moved onto the `cli`
transport automatically**, and the panel says so on the server's level rather
than leaving you to work out why a handshake keeps failing:

```
using the cli transport: a client certificate cannot be sent over http from the shell
```

It needs somewhere to dial. The HTTP port is not the gRPC port, so an entry with
only a `url` cannot be moved, and is reported as a config error with the fix in
it rather than polled once a tick to fail the same way:

> mTLS needs the cli transport, and this server has no gRPC address to use. Add
> `"address": "host:7233"` (or a `"profile"`).

```json
{
  "label": "prod",
  "transport": "cli",
  "address": "temporal.corp.example:7233",
  "uiUrl": "https://temporal.corp.example",
  "tlsCertPath": "~/certs/client.pem",
  "tlsKeyPath": "~/certs/client.key",
  "tlsCaPath": "~/certs/ca.pem",
  "tlsServerName": "temporal.corp.example"
}
```

`~` is expanded. Each field maps to the identically named CLI flag, so a working
`temporal --tls-cert-path … --tls-key-path …` command transcribes directly:

| Field | Flag |
|---|---|
| `tlsCertPath` | `--tls-cert-path` |
| `tlsKeyPath` | `--tls-key-path` |
| `tlsCaPath` | `--tls-ca-path` |
| `tlsServerName` | `--tls-server-name` |
| `tlsDisableHostVerification` | `--tls-disable-host-verification` |
| `tls` | `--tls` / `--tls=false` |

A `tlsCaPath` **on its own** is server verification, not client identity, so it
does not force the `cli` transport — but it is also ignored on `http`, where the
shell uses the system trust store. If your CA is not in it, use `cli`. The panel
warns when TLS settings are set on an `http` server for exactly this reason.

> **Do not use `TEMPORAL_TLS_CERT_PATH`.** If you are setting these by hand in
> the environment for some other tool, note that the CLI's env var names do not
> match its flag names: the working ones are `TEMPORAL_TLS_CLIENT_CERT_PATH`,
> `TEMPORAL_TLS_CLIENT_KEY_PATH` and `TEMPORAL_TLS_SERVER_CA_CERT_PATH`. The
> flag-shaped spellings are silently ignored — no warning, just a plaintext
> connection. This plugin uses the flags, so it is not affected.

### Custom headers — both transports

Self-hosted Temporal behind Cloudflare Access, an ingress, or an oauth2-proxy
usually needs a header pair the Temporal server itself knows nothing about.

```json
{
  "label": "prod",
  "url": "https://temporal.corp.example",
  "apiKeyCommand": "pass show temporal/prod",
  "headers": {
    "CF-Access-Client-Id": "….access",
    "CF-Access-Client-Secret": "…"
  }
}
```

A list of pasted lines works too, because that is the form a proxy's own setup
page gives you:

```json
{ "headers": ["CF-Access-Client-Id: ….access", "CF-Access-Client-Secret: …"] }
```

**`http`** — sent as themselves. `Accept` cannot be overridden. `Authorization`
can be, but only when there is no API key to build one from, which is how you
send a `Basic` credential.

**`cli`** — sent as gRPC metadata, through `TEMPORAL_GRPC_META_<NAME>` with
dashes written as underscores, which `temporal --help` documents as equivalent
to `--grpc-meta KEY=VALUE`. Verified on the wire: the same header comes out
either way. A header name that is not a legal environment-variable suffix falls
back to the flag and is therefore visible in `ps` — no name people actually use
hits this, but it is the one hole left.

Two things worth knowing about headers and the HTTP API:

- **Temporal drops what it does not recognise.** Only `Authorization`,
  `Authorization-Extras`, `X-Forwarded-For`, `Client-Name`, `Client-Version`,
  IANA permanent headers and `Grpc-Metadata-*` are forwarded to the gRPC layer.
  For Cloudflare Access that is exactly right — the edge consumes the pair
  before Temporal ever sees it.
- **`headers` values live in `shell.json` in the clear.** There is no
  `headersCommand`. Cloudflare service-token secrets are long-lived rather than
  rotating, which is why this is tolerable and `apiKey` is not; if you would
  rather they were not there, put them in a `temporal.toml` profile and use the
  `cli` transport.

### Temporal Cloud — `cli` transport only

**Cloud does not publish the HTTP API, and this plugin refuses to pretend it
does.** Probing `us-east-1.aws.api.temporal.io:7243` gets a `401` with
`www-authenticate: Bearer realm=…` from an authenticating proxy — but so does
`GET /nope` on the same port, because the proxy rejects before it routes. That
proves an authenticating Temporal HTTP frontend is listening; it proves nothing
about whether `/api/v1/...` is served behind it. There is no documentation, no
changelog entry and no Cloud-side reference to it. **Unconfirmed, so
unsupported.**

Configuring a Cloud endpoint with `transport: "http"` is therefore reported as a
config error with the `cli` spelling in it, rather than left to fail as a
mysterious 401.

Do not confuse this with the **Cloud Ops API** (`saas-api.tmprl.cloud`), which is
control-plane only — its own documentation says it "does not allow interaction
with individual Workflows or Activities via HTTP".

```json
{
  "label": "cloud",
  "transport": "cli",
  "address": "orders.a1b2c.tmprl.cloud:7233",
  "namespaces": ["orders.a1b2c"],
  "uiUrl": "https://cloud.temporal.io",
  "apiKeyCommand": "op read op://Work/temporal-cloud/credential"
}
```

Three Cloud-specific things:

- **Namespaces are `<name>.<account>` everywhere** — CLI, SDK and API. A bare
  `orders` earns a `NamespaceNotFound` that reads like the namespace was
  deleted. The plugin warns when a Cloud server's configured namespaces have no
  account suffix.
- **Two endpoint shapes, both on 7233.** The namespace endpoint
  `<ns>.<account>.tmprl.cloud:7233` is the one to prefer: it works for both API
  keys and mTLS, and routes to the active region for a high-availability
  namespace. The regional endpoint `<region>.<cloud>.api.temporal.io:7233` also
  works, but with mTLS you must set `tlsServerName` to the namespace endpoint.
- **API keys and mTLS are alternatives, not layers.** Using both on one
  namespace is pre-release and gated behind Temporal support.

Cloud also authorizes per namespace, which makes the namespace fallback below
the normal case rather than the exotic one.

---

## Namespace-level authorization

`ListNamespaces` is a **cluster-level** call. A credential scoped to two
namespaces can read both of them and still be refused the list — Temporal Cloud
API keys behave exactly this way.

The plugin used to fail the whole server for that, hiding data the token was
entitled to. Now, when namespace discovery is refused it falls back, in order:

1. the `namespaces` configured for that server,
2. failing that, the namespaces that worked on the last poll,
3. failing that, it does fail the server — but with the fix rather than the
   symptom:

   > no permission to list namespaces. Add `"namespaces": ["…"]` to this server
   > so it reads them directly instead of listing them.

When it falls back, the server's level says so:

> cannot list namespaces (no permission to list namespaces); using the 2
> configured for this server

So for any scoped credential, name the namespaces and skip the whole dance:

```json
{
  "label": "cloud",
  "transport": "cli",
  "address": "orders.a1b2c.tmprl.cloud:7233",
  "namespaces": ["orders.a1b2c", "payments.a1b2c"],
  "apiKeyCommand": "op read op://Work/temporal-cloud/credential"
}
```

---

## What a failure looks like

Authentication failures are their own state, distinct from an unreachable
server, because they have a different fix. The corner of the server row says
which:

| Row says | Means |
|---|---|
| `token rejected` | the credential was not accepted — expired, or not a key for this server |
| `no permission` | the credential is real and does not cover this namespace or call |
| `tls failed` | the handshake did not complete: bad CA, wrong server name, unreadable certificate |
| `misconfigured` | it cannot work as configured; the row underneath says what to change |
| `unreachable` | nothing answered |

### Temporal makes 401 and 403 harder to tell apart than they look

Self-hosted Temporal's authorization interceptor answers **every** claim-mapping
failure with `PERMISSION_DENIED` and the deliberately uninformative string
`Request unauthorized.` — a malformed token, an expired one and a missing
permission are one status and one string, on purpose, so the server does not
help an attacker.

So the classifier reads that exact phrasing as an *authentication* failure worth
refreshing the token for, and a code 7 carrying anything else as an
*authorization* one. It is the best split the wire allows.

One more code 7 that is not an authorization failure at all: if
`frontend.httpAllowedHosts` is tightened and your proxied hostname is not in it,
Temporal answers `{"code": 7, "message": "Host not allowed"}`. That is called out
by name, because hunting for a missing permission that was never the problem
costs an afternoon.

---

## Secrets and argv

`/proc/<pid>/cmdline` is world readable. Every user on the machine can read the
command line of every process, for as long as it lives.

This plugin used to put the API key on two command lines: once passing the
collector spec as an argument to `collect.py`, and again passing `--api-key` to
`temporal` — once per namespace, per poll, forever. Both are fixed:

- the spec reaches `collect.py` on **stdin**,
- credentials reach `temporal` in the **environment** (`TEMPORAL_API_KEY`,
  `TEMPORAL_GRPC_META_*`), which `/proc` exposes only to the owning user.

TLS *paths* are still flags. A path is not a secret; the key it points at never
leaves the file.

Two holes remain, both outside this plugin's reach:

- **A custom header whose name cannot be spelled as an environment variable**
  falls back to `--grpc-meta NAME=VALUE`. No header name in normal use hits
  this.
- **Saving an inline `apiKey`** goes through
  `omarchy-shell shell setBarWidget <id> servers <json>`, which is that
  process's command line. The shell owns `shell.json` and this is the only
  sanctioned way to write it. It is momentary, and it is one more reason the
  answer to "where do I put the token" is `apiKeyCommand`. The warning attached
  to `apiKey` says so.

Two more places a token could get out, both closed:

- **Error text.** Anything on its way to the panel, to `doctor` or to the
  journal is scrubbed of the server's own secrets, of anything matching
  `Bearer <token>`, and of anything matching `--api-key <value>` — because a Go
  client printing the metadata it sent is exactly the kind of thing that shows
  up in a stack trace one release later.
- **`apiKeyCommand` output.** Its stdout is the token and its stderr may quote
  it back, so neither is ever logged or shown. A failure is reported as a label
  and an exit code.

`omtemporal add … apiKey=…` will warn you that the value is now in your shell
history as well as in `shell.json`.

---

## Testing this

`temporal server start-dev` **cannot enforce authentication**. It has no
`--authorizer` and no `--config`, it rejects both flags outright, and it ignores
the `TEMPORAL_AUTH_*` variables the full server distribution reads — asked to
print its own config it comes back with `authorizer: ""`. An unauthenticated
request and one carrying `Authorization: Bearer totally-fake` both return `200`.

So the test bed puts a proxy in front of one instead, which is also the topology
the feature is really for:

```bash
docker compose -f testbed/compose.yaml --profile auth up -d authproxy
node testbed/parity-test.mjs
```

`testbed/authproxy.py` (stdlib only) reproduces the three behaviours that matter:
a missing or wrong token gets `401 {"code": 16}`, a valid token gets `403` on
`ListNamespaces` only, and the Cloudflare-style header pair is required. The
suite asserts against it that the headers `Model.httpHeaders` builds actually
authenticate, that the refusal is classified as an auth failure, and that the
namespace fallback then reads the configured namespaces successfully.

It is behind a compose profile, so the default `docker compose up` is unchanged.

---

## Field reference

| Key | Transport | Meaning |
|---|---|---|
| `apiKey` | both | Bearer token, inline. Warned about. |
| `apiKeyCommand` | both | Shell command whose stdout is the token. Preferred. |
| `apiKeyTtlSec` | both | How long a resolved token is reused. Default 900; `0` disables re-resolution. |
| `headers` | both | Extra headers, as a map or as `"Name: value"` lines. |
| `profile` | `cli` | A `temporal.toml` profile. Brings its own address, credentials and TLS. |
| `tls` | `cli` | Force base TLS on or off. Omit to let the CLI decide. |
| `tlsCertPath` | `cli` | Client certificate. Forces the `cli` transport. |
| `tlsKeyPath` | `cli` | Its key. Required with `tlsCertPath`. |
| `tlsCaPath` | `cli` | CA to verify the server with. |
| `tlsServerName` | `cli` | Override the expected TLS server name (SNI). |
| `tlsDisableHostVerification` | `cli` | Do not check the server's identity. Warned about. |
| `namespaces` | both | Pin the namespaces, for a credential that cannot list them. |

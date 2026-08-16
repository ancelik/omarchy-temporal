// Pure helpers for the Temporal bar plugin: parsing what Temporal actually
// returns -- over the HTTP API and over the CLI, which differ in a couple of
// small, specific ways -- and turning it into the strings and numbers the panel
// draws. No QML types in here, so every function is checkable against a
// recorded response.

// --- execution status ---------------------------------------------------------

// The order statuses are shown in: what is happening now, then what went
// wrong, then the quiet ones. Count chips read left to right in this order.
var STATUS_ORDER = [
  "Running",
  "Failed",
  "TimedOut",
  "Terminated",
  "Canceled",
  "ContinuedAsNew",
  "Completed"
]

var STATUS_GLYPH = {
  Running: "󰑮",
  Completed: "󰄬",
  Failed: "󰅖",
  Canceled: "󰜺",
  Terminated: "󰝤",
  TimedOut: "󰥔",
  ContinuedAsNew: "󰑖",
  Unknown: "󰋗"
}

var STATUS_LABEL = {
  Running: "Running",
  Completed: "Completed",
  Failed: "Failed",
  Canceled: "Canceled",
  Terminated: "Terminated",
  TimedOut: "Timed out",
  ContinuedAsNew: "Continued",
  Unknown: "Unknown"
}

// Short forms for the count chips, where horizontal space is the constraint.
var STATUS_SHORT = {
  Running: "run",
  Completed: "done",
  Failed: "fail",
  Canceled: "cancel",
  Terminated: "term",
  TimedOut: "timeout",
  ContinuedAsNew: "cont",
  Unknown: "?"
}

// Statuses that mean "someone should look at this". Drives the urgent color in
// the panel and the failure count on the bar.
var BAD_STATUSES = { Failed: true, TimedOut: true, Terminated: true }

// WORKFLOW_EXECUTION_STATUS_TIMED_OUT -> TimedOut. The list endpoint reports
// the full enum name while the grouped-count endpoint reports the short form,
// so both spellings have to land on the same key.
function statusKey(raw) {
  var value = String(raw || "")
  if (value === "") return "Unknown"
  var prefix = "WORKFLOW_EXECUTION_STATUS_"
  if (value.indexOf(prefix) !== 0) return STATUS_LABEL[value] ? value : titleCase(value)
  var words = value.substring(prefix.length).split("_")
  var out = ""
  for (var i = 0; i < words.length; i++) out += titleCase(words[i])
  return STATUS_LABEL[out] ? out : "Unknown"
}

function titleCase(word) {
  var value = String(word || "").toLowerCase()
  return value === "" ? "" : value.charAt(0).toUpperCase() + value.substring(1)
}

function statusLabel(key) { return STATUS_LABEL[key] || STATUS_LABEL.Unknown }
function statusGlyph(key) { return STATUS_GLYPH[key] || STATUS_GLYPH.Unknown }
function statusShort(key) { return STATUS_SHORT[key] || STATUS_SHORT.Unknown }
function isBad(key) { return BAD_STATUSES[key] === true }
function isOpen(key) { return key === "Running" }

// Anything that reaches this file from shell.json or from a QML `var` property
// has crossed a QVariant boundary, and comes back as a sequence object that
// indexes and iterates like an array but that Array.isArray flatly rejects.
// Duck-typing is what the first-party plugins do for the same reason.
function isList(value) {
  return !!value && typeof value !== "string" && typeof value.length === "number"
}

// --- primitives ------------------------------------------------------------------

// One table describing every Temporal concept the panel draws. Rows, section
// headers and breadcrumbs all read their glyph and wording from here, so a
// primitive looks and reads the same everywhere it appears -- which is the
// whole point of showing more than one of them.
var PRIMITIVES = {
  server:    { glyph: "󰒋", one: "Server",           many: "SERVERS",          hint: "A Temporal Service: one cluster, with its own namespaces." },
  namespace: { glyph: "󰉋", one: "Namespace",        many: "NAMESPACES",       hint: "An isolated unit inside a server. Workflows never cross one." },
  workflow:  { glyph: "󰑮", one: "Workflow",         many: "WORKFLOWS",        hint: "A durable function execution. Survives restarts, keeps its history." },
  activity:  { glyph: "󱐋", one: "Activity",         many: "ACTIVITIES",       hint: "A single retryable step a Workflow calls out to." },
  taskQueue: { glyph: "󰉻", one: "Task queue",       many: "TASK QUEUES",      hint: "The named channel Workers poll for work." },
  worker:    { glyph: "󰍹", one: "Worker",           many: "WORKERS POLLING",  hint: "A process polling a task queue. No worker, no progress." },
  schedule:  { glyph: "󰃰", one: "Schedule",         many: "SCHEDULES",        hint: "A recurring rule that starts Workflows for you." },
  batch:     { glyph: "󰌨", one: "Batch operation",  many: "BATCH OPERATIONS", hint: "One action applied across many Workflows at once." },
  cluster:   { glyph: "󰆼", one: "Cluster",          many: "CLUSTER",          hint: "Version and storage backing this server." }
}

function primitive(kind) {
  return PRIMITIVES[kind] || { glyph: "󰋗", one: String(kind), many: String(kind).toUpperCase(), hint: "" }
}

function primitiveGlyph(kind) { return primitive(kind).glyph }
function primitiveLabel(kind) { return primitive(kind).one }
function primitiveHeading(kind) { return primitive(kind).many }
function primitiveHint(kind) { return primitive(kind).hint }

// --- base64 ------------------------------------------------------------------------

var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// Qt.atob would do this, but it is deprecated and logs a warning on every
// call -- roughly a dozen per poll, which would bury the shared shell log.
// Status names are ASCII, so a plain byte decode is all that is needed.
function decodeBase64(input) {
  var value = String(input || "").replace(/[^A-Za-z0-9+\/]/g, "")
  var out = ""
  for (var i = 0; i < value.length; i += 4) {
    var chunk = (BASE64_ALPHABET.indexOf(value.charAt(i)) << 18)
      | (BASE64_ALPHABET.indexOf(value.charAt(i + 1)) << 12)
      | ((i + 2 < value.length ? BASE64_ALPHABET.indexOf(value.charAt(i + 2)) : 0) << 6)
      | (i + 3 < value.length ? BASE64_ALPHABET.indexOf(value.charAt(i + 3)) : 0)
    out += String.fromCharCode((chunk >> 16) & 0xff)
    if (i + 2 < value.length) out += String.fromCharCode((chunk >> 8) & 0xff)
    if (i + 3 < value.length) out += String.fromCharCode(chunk & 0xff)
  }
  return out
}

// --- transport-shape smoothing ------------------------------------------------------

// The CLI prints bare JSON arrays where the HTTP API wraps the same objects in
// a named field. Every list parser goes through here so neither transport needs
// its own copy of the parsing below.
function unwrap(json, key) {
  if (isList(json)) return json
  if (!json) return []
  var value = json[key]
  return isList(value) ? value : []
}

// --- request building ----------------------------------------------------------------

function trimSlashes(value) {
  return String(value || "").replace(/\/+$/, "")
}

// One place that knows the API is rooted at /api/v1, so a server configured
// with or without that suffix behaves the same.
function apiBase(url) {
  var base = trimSlashes(url)
  return base.match(/\/api\/v1$/) ? base : base + "/api/v1"
}

function namespacesUrl(url) {
  return apiBase(url) + "/namespaces?pageSize=100"
}

function clusterUrl(url) {
  return apiBase(url) + "/cluster-info"
}

function namespaceUrl(url, namespace) {
  return apiBase(url) + "/namespaces/" + encodeURIComponent(namespace)
}

function workflowsUrl(url, namespace, limit) {
  // Deliberately no ORDER BY: the SQLite visibility store the dev server uses
  // rejects it outright ("operation is not supported"), and every store
  // already returns newest first. The panel re-sorts client side anyway.
  return apiBase(url) + "/namespaces/" + encodeURIComponent(namespace)
    + "/workflows?pageSize=" + Math.max(1, Number(limit) || 25)
}

function countUrl(url, namespace) {
  return apiBase(url) + "/namespaces/" + encodeURIComponent(namespace)
    + "/workflow-count?query=" + encodeURIComponent("GROUP BY ExecutionStatus")
}

function describeUrl(url, namespace, workflowId, runId) {
  var target = apiBase(url) + "/namespaces/" + encodeURIComponent(namespace)
    + "/workflows/" + encodeURIComponent(workflowId)
  return runId ? target + "?execution.runId=" + encodeURIComponent(runId) : target
}

function taskQueueUrl(url, namespace, taskQueue, type) {
  return apiBase(url) + "/namespaces/" + encodeURIComponent(namespace)
    + "/task-queues/" + encodeURIComponent(taskQueue)
    + "?taskQueueType=" + encodeURIComponent(type || "TASK_QUEUE_TYPE_WORKFLOW")
    + "&reportStats=true&reportPollers=true"
}

function schedulesUrl(url, namespace, limit) {
  return apiBase(url) + "/namespaces/" + encodeURIComponent(namespace)
    + "/schedules?maximumPageSize=" + Math.max(1, Number(limit) || 20)
}

function batchUrl(url, namespace, limit) {
  return apiBase(url) + "/namespaces/" + encodeURIComponent(namespace)
    + "/batch-operations?pageSize=" + Math.max(1, Number(limit) || 20)
}

// The Web UI lives on a different port from the API, so it is configured
// separately; falling back to the API host at least lands on the right server.
function workflowUiUrl(uiUrl, namespace, workflowId, runId) {
  var base = trimSlashes(uiUrl)
  if (base === "") return ""
  return base + "/namespaces/" + encodeURIComponent(namespace)
    + "/workflows/" + encodeURIComponent(workflowId)
    + "/" + encodeURIComponent(runId) + "/history"
}

function namespaceUiUrl(uiUrl, namespace) {
  var base = trimSlashes(uiUrl)
  if (base === "") return ""
  return base + "/namespaces/" + encodeURIComponent(namespace) + "/workflows"
}

// --- server configuration ----------------------------------------------------

var TRANSPORTS = ["http", "cli"]

// Accepts the `servers` value from shell.json in the forms people actually
// write it: absent, a single object, a bare URL string, or a list of any mix
// of those. An empty result is preserved as empty -- that is what tells the
// panel to open on onboarding rather than on an empty fleet.
//
// It also accepts `{ "list": [...] }`. That is the form the setup screen
// writes, because the shell's setBarWidget IPC silently drops a value that is
// a bare array while preserving one nested inside an object. Hand-written
// configs can keep using the plain array.
function normalizeServers(raw) {
  if (raw === undefined || raw === null || raw === "") return []
  if (!isList(raw) && typeof raw === "object" && (isList(raw.list) || isList(raw.servers))) {
    raw = isList(raw.list) ? raw.list : raw.servers
  }
  var list = isList(raw) ? raw : [raw]
  var out = []
  for (var i = 0; i < list.length; i++) {
    var server = normalizeServer(list[i], out.length)
    if (server) out.push(server)
  }
  return out
}

function normalizeServer(entry, index) {
  var value = entry
  if (typeof value === "string") value = { url: value }
  if (!value || typeof value !== "object") return null

  var url = trimSlashes(value.url || "")
  if (url !== "" && !url.match(/^https?:\/\//)) url = "http://" + url

  var address = String(value.address || "").trim()
  var profile = String(value.profile || "").trim()

  // Transport is an explicit choice, but an entry carrying only a gRPC address
  // or a CLI profile can mean just one thing, so it is inferred rather than
  // rejected.
  var transport = String(value.transport || "").toLowerCase()
  if (TRANSPORTS.indexOf(transport) === -1) transport = url !== "" ? "http" : "cli"

  // A client certificate is presented during the TLS handshake, and QML's
  // XMLHttpRequest has no way to hand one over. An entry that carries one is
  // moved onto the cli transport rather than left to fail its handshake once a
  // tick with an error nobody can act on. It needs somewhere to dial, though --
  // the HTTP port is not the gRPC port -- so without an address or a profile it
  // stays as configured and authConfigIssues() reports it as a fixable error.
  var tls = normalizeTls(value)
  var transportNote = ""
  if (tls.mutual && transport === "http" && (address !== "" || profile !== "")) {
    transport = "cli"
    transportNote = "using the cli transport: a client certificate cannot be sent over http from the shell"
  }

  if (transport === "http" && url === "") return null
  if (transport === "cli" && address === "" && profile === "") {
    // A CLI server described only by its HTTP url can still be reached: hand
    // the CLI the host and let it dial the gRPC port it was given.
    address = hostOf(url)
    if (address === "") return null
  }

  var namespaces = []
  if (typeof value.namespaces === "string") {
    namespaces = String(value.namespaces).split(",").map(function (n) { return n.trim() })
      .filter(function (n) { return n !== "" })
  } else if (isList(value.namespaces)) {
    for (var i = 0; i < value.namespaces.length; i++) {
      var name = String(value.namespaces[i] || "").trim()
      if (name !== "") namespaces.push(name)
    }
  }

  return {
    index: index,
    label: String(value.label || value.name || hostOf(url) || address || profile || ("server " + (index + 1))),
    transport: transport,
    url: url,
    address: address,
    profile: profile,
    uiUrl: trimSlashes(value.uiUrl || value.ui || ""),
    namespaces: namespaces,
    apiKey: String(value.apiKey || ""),
    apiKeyCommand: String(value.apiKeyCommand || ""),
    // Tokens expire, usually on the hour. Zero means "resolve once and keep
    // it", which is what this plugin used to do unconditionally.
    apiKeyTtlSec: ttlSetting(value.apiKeyTtlSec),
    headers: normalizeHeaders(value.headers),
    tls: tls,
    transportNote: transportNote
  }
}

var DEFAULT_KEY_TTL_SEC = 900

function ttlSetting(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_KEY_TTL_SEC
  var n = parseInt(String(raw), 10)
  if (!isFinite(n) || n < 0) return DEFAULT_KEY_TTL_SEC
  return n
}

// What onboarding writes back to shell.json. Only keys that carry a value
// survive, so a hand-edited config does not come back as a wall of defaults the
// first time the panel touches it.
function serverToConfig(server) {
  var out = { label: server.label, transport: server.transport }
  if (server.url) out.url = server.url
  if (server.address) out.address = server.address
  if (server.profile) out.profile = server.profile
  if (server.uiUrl) out.uiUrl = server.uiUrl
  if (server.namespaces && server.namespaces.length > 0) out.namespaces = server.namespaces
  if (server.apiKey) out.apiKey = server.apiKey
  if (server.apiKeyCommand) out.apiKeyCommand = server.apiKeyCommand
  if (server.apiKeyCommand && server.apiKeyTtlSec !== DEFAULT_KEY_TTL_SEC) {
    out.apiKeyTtlSec = server.apiKeyTtlSec
  }
  if (headerCount(server.headers) > 0) out.headers = server.headers
  var tls = server.tls || normalizeTls({})
  if (tls.certPath) out.tlsCertPath = tls.certPath
  if (tls.keyPath) out.tlsKeyPath = tls.keyPath
  if (tls.caPath) out.tlsCaPath = tls.caPath
  if (tls.serverName) out.tlsServerName = tls.serverName
  if (tls.disableHostVerification) out.tlsDisableHostVerification = true
  if (tls.enabled !== null) out.tls = tls.enabled
  return out
}

function serversToConfig(servers) {
  var list = isList(servers) ? servers : []
  var out = []
  for (var i = 0; i < list.length; i++) out.push(serverToConfig(list[i]))
  return out
}

function hostOf(url) {
  var match = String(url || "").match(/^https?:\/\/([^\/?#]+)/)
  return match ? match[1] : String(url || "")
}

// How a server describes itself in a row: the thing you would type to reach it.
function serverAddressText(server) {
  if (!server) return ""
  if (server.transport === "cli") return server.profile ? "profile " + server.profile : server.address
  return hostOf(server.url)
}

// Namespaces that exist for the server's own bookkeeping. Showing them would
// bury the user's own namespaces under noise they cannot act on.
function isInternalNamespace(name) {
  return String(name || "") === "temporal-system"
}

// --- authentication and authorization -------------------------------------------
//
// Everything here is a decision, not an action: which credential a server
// carries, whether that credential is even expressible over the transport it
// asked for, what a rejection actually means, and what to do when a token can
// read a namespace but not list them. The transports call into this so both
// reach the same conclusion from the same evidence.

// Header names are case-insensitive on the wire but not in a JS object, so they
// are folded to one canonical spelling. Anything the caller sets wins over the
// defaults except Authorization, which is built from apiKey when one exists.
var RESERVED_HEADERS = { accept: true, "content-length": true, host: true }

// Accepts the shapes people write headers in: a map, or a list of
// "Name: value" / "Name=value" strings, which is what gets pasted out of a
// proxy's setup instructions.
function normalizeHeaders(raw) {
  var out = {}
  if (!raw) return out

  if (isList(raw)) {
    for (var i = 0; i < raw.length; i++) {
      var line = String(raw[i] || "")
      var cut = line.indexOf(":")
      if (cut === -1) cut = line.indexOf("=")
      if (cut <= 0) continue
      putHeader(out, line.substring(0, cut), line.substring(cut + 1))
    }
    return out
  }

  if (typeof raw === "object") {
    for (var name in raw) putHeader(out, name, raw[name])
  }
  return out
}

function putHeader(map, name, value) {
  var key = String(name || "").trim()
  if (key === "") return
  // Setting Accept or Host from config breaks the request in ways that look
  // like a server fault, so those are the two the user does not get to own.
  if (RESERVED_HEADERS[key.toLowerCase()] === true) return
  map[key] = String(value === undefined || value === null ? "" : value).trim()
}

function headerCount(headers) {
  var n = 0
  for (var name in headers) n += 1
  return n
}

// The TLS material a server presents, as the `temporal` CLI names it. The names
// are copied from the flags on purpose: someone who has a working
// `temporal --tls-cert-path ...` command should be able to transcribe it.
function normalizeTls(value) {
  var tls = {
    certPath: expandHome(value.tlsCertPath || value.tlsCert || ""),
    keyPath: expandHome(value.tlsKeyPath || value.tlsKey || ""),
    caPath: expandHome(value.tlsCaPath || value.tlsCa || ""),
    serverName: String(value.tlsServerName || "").trim(),
    disableHostVerification: value.tlsDisableHostVerification === true,
    // `temporal` switches TLS on by itself the moment an api key or any tls
    // option is present, which is right everywhere except a cleartext proxy on
    // localhost. null means "let the CLI decide", which is what it should do.
    enabled: triState(value.tls)
  }
  // A CA on its own is server verification, not client identity. Only a
  // cert+key pair is mTLS, and only mTLS is the thing XMLHttpRequest cannot do.
  tls.mutual = tls.certPath !== "" || tls.keyPath !== ""
  tls.any = tls.mutual || tls.caPath !== "" || tls.serverName !== "" || tls.disableHostVerification
  return tls
}

// ~/certs/... is how people write paths, and neither QML nor `temporal` expands
// it. Done here so the path in the panel is the path that was actually used.
function triState(value) {
  if (value === undefined || value === null || value === "") return null
  return value === true || value === "true"
}

function expandHome(raw) {
  var path = String(raw || "").trim()
  if (path === "~") return homeDir()
  if (path.indexOf("~/") === 0) return homeDir() + path.substring(1)
  return path
}

var HOME_DIR = ""

function homeDir() {
  return HOME_DIR
}

function setHomeDir(path) {
  HOME_DIR = String(path || "").replace(/\/+$/, "")
}

// What a server's credentials add up to, in the order they matter. `text` is
// the one-liner the panel and `omtemporal doctor` both show; nothing here ever
// contains the secret itself.
function authSummary(server) {
  var modes = []
  if (!server) return { modes: modes, text: "none", requiresCli: false, reason: "" }

  if (String(server.apiKey || "") !== "") modes.push("apiKey")
  else if (String(server.apiKeyCommand || "") !== "") modes.push("apiKeyCommand")
  var tls = server.tls || normalizeTls({})
  if (tls.mutual) modes.push("mtls")
  else if (tls.any) modes.push("tls")
  if (headerCount(server.headers) > 0) modes.push("headers")
  if (String(server.profile || "") !== "") modes.push("profile")

  var parts = []
  for (var i = 0; i < modes.length; i++) parts.push(AUTH_MODE_TEXT[modes[i]] || modes[i])
  if (modes.indexOf("headers") !== -1) {
    parts[parts.length - 1] = plural(headerCount(server.headers), "custom header")
  }

  return {
    modes: modes,
    text: parts.length > 0 ? parts.join(" · ") : "none",
    // A client certificate has to be presented during the handshake, and QML's
    // XMLHttpRequest has no way to hand one over. That is a hard fact about the
    // transport, not a missing feature here.
    requiresCli: tls.mutual,
    reason: tls.mutual ? "a client certificate can only be presented by the cli transport" : ""
  }
}

var AUTH_MODE_TEXT = {
  apiKey: "api key (inline)",
  apiKeyCommand: "api key (command)",
  mtls: "mTLS",
  tls: "custom tls",
  headers: "custom headers",
  profile: "cli profile"
}

// Problems worth telling the user about before a request is ever made. Errors
// stop the server from being polled at all -- there is no point earning a
// handshake failure once a tick when the config cannot work. Warnings are
// things that will work and probably should not.
function authConfigIssues(server) {
  var issues = []
  if (!server) return issues

  var tls = server.tls || normalizeTls({})

  if (tls.mutual && (tls.certPath === "" || tls.keyPath === "")) {
    issues.push(issue("error",
      "mTLS needs both tlsCertPath and tlsKeyPath; only "
        + (tls.certPath !== "" ? "the certificate" : "the key") + " is set"))
  }

  if (tls.mutual && server.transport === "http") {
    // Reached only when the entry gives no gRPC address to switch to;
    // normalizeServer moves the rest onto the cli transport by itself.
    issues.push(issue("error",
      "mTLS needs the cli transport, and this server has no gRPC address to use. "
        + "Add \"address\": \"host:7233\" (or a \"profile\")."))
  }

  if (String(server.apiKey || "") !== "" && String(server.apiKeyCommand || "") !== "") {
    issues.push(issue("warn", "apiKey and apiKeyCommand are both set; the inline apiKey wins"))
  }

  if (String(server.apiKey || "") !== "") {
    issues.push(issue("warn",
      "apiKey is stored in plain text in shell.json; apiKeyCommand keeps it in your password manager"))
  }

  // A bearer token over cleartext http is handed to anything on the path. Local
  // loopback is the exception, and it is the common one, so it is not flagged.
  if (server.transport === "http" && server.url.indexOf("http://") === 0 && !isLoopback(server.url)
      && (String(server.apiKey || "") !== "" || String(server.apiKeyCommand || "") !== ""
        || headerCount(server.headers) > 0)) {
    issues.push(issue("warn", "credentials are sent over plain http to " + hostOf(server.url)))
  }

  if (tls.disableHostVerification) {
    issues.push(issue("warn", "tlsDisableHostVerification is on; the server's identity is not checked"))
  }

  if (server.transport === "http" && isCloudEndpoint(server.url)) {
    issues.push(issue("error",
      "Temporal Cloud does not publish an HTTP API. Use the cli transport with "
        + "\"address\": \"<namespace>.<account>.tmprl.cloud:7233\"."))
  }

  if (server.transport === "cli" && isCloudEndpoint(server.address)
      && server.namespaces.length > 0) {
    for (var n = 0; n < server.namespaces.length; n++) {
      // On Cloud the namespace *is* name.accountid everywhere -- CLI, SDK and
      // API. A bare name earns a NamespaceNotFound that reads like the
      // namespace was deleted.
      if (server.namespaces[n].indexOf(".") === -1) {
        issues.push(issue("warn",
          "Temporal Cloud namespaces are named <namespace>.<account>; \""
            + server.namespaces[n] + "\" has no account suffix"))
      }
    }
  }

  if (tls.any && server.transport === "http" && !tls.mutual) {
    issues.push(issue("warn",
      "tls settings are ignored on the http transport; the shell's http client uses the system trust store"))
  }

  return issues
}

function issue(level, text) {
  return { level: level, text: String(text) }
}

function hasConfigError(server) {
  var issues = authConfigIssues(server)
  for (var i = 0; i < issues.length; i++) if (issues[i].level === "error") return issues[i].text
  return ""
}

// Temporal Cloud namespace and regional endpoints. Cloud has no documented
// HTTP API -- probing one gets a 401 from the auth proxy in front of it, which
// says an authenticating frontend is listening and nothing at all about whether
// /api/v1 is routed. So the http transport is not offered for these.
function isCloudEndpoint(target) {
  var host = hostOf(target).toLowerCase()
  return /(^|\.)tmprl\.cloud(:|$)/.test(host) || /(^|\.)api\.temporal\.io(:|$)/.test(host)
}

function isLoopback(url) {
  var host = hostOf(url).split(":")[0]
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
}

// The headers an http request carries. Built here rather than in Service.qml so
// the precedence -- defaults, then the user's, then the api key -- is one
// testable rule instead of a sequence of setRequestHeader calls.
function httpHeaders(server, apiKey) {
  var headers = { Accept: "application/json" }
  var custom = (server && server.headers) || {}
  for (var name in custom) headers[name] = custom[name]

  var key = String(apiKey || "")
  // A hand-written Authorization header (Basic, or a token shape Temporal does
  // not call an api key) is left alone when there is no api key to override it.
  if (key !== "") headers.Authorization = "Bearer " + key
  return headers
}

// The auth half of the collector spec. collect.py turns this into flags and
// environment; keeping the decision here means the CLI and HTTP paths cannot
// disagree about what a server's credentials are.
function authSpec(server, apiKey) {
  var tls = (server && server.tls) || normalizeTls({})
  return {
    apiKey: String(apiKey || ""),
    headers: (server && server.headers) || {},
    tlsCertPath: tls.certPath,
    tlsKeyPath: tls.keyPath,
    tlsCaPath: tls.caPath,
    tlsServerName: tls.serverName,
    tlsDisableHostVerification: tls.disableHostVerification === true,
    tls: tls.enabled
  }
}

// --- error classification ---------------------------------------------------------
//
// "Unreachable" and "your token expired" are different problems with different
// fixes, and until now the panel called both of them the same thing. Both
// transports funnel their failures through here.

// gRPC's UNAUTHENTICATED (16) and PERMISSION_DENIED (7) reach us three ways:
// as an HTTP status from the API, as a `code` in the JSON error body, and as
// English in the CLI's stderr. All three have to land on the same kind.
//
// Self-hosted Temporal makes this harder than it looks. Its authorization
// interceptor answers *every* claim-mapping failure with PermissionDenied and
// the deliberately uninformative "Request unauthorized." -- a malformed token,
// an expired one and a missing permission are one status and one string. So
// that exact phrasing is read as an authentication failure (worth refreshing
// the token for) and a code 7 carrying anything else as an authorization one.
var AUTH_PATTERNS = [
  /unauthenticated/i,
  /invalid[ _-]?(api[ _-]?key|token|credential)/i,
  /token (is )?(expired|invalid|rejected)/i,
  /request unauthorized/i,
  /authentication (failed|error)/i,
  /\bcode = Unauthenticated\b/
]

var DENIED_PATTERNS = [
  /permission[ _]?denied/i,
  /not authorized/i,
  /unauthorized to/i,
  /forbidden/i,
  /\bcode = PermissionDenied\b/
]

var NETWORK_PATTERNS = [
  /connection refused/i,
  /no such host/i,
  /name resolution/i,
  /\bcode = Unavailable\b/,
  /last connection error/i,
  /context deadline exceeded/i,
  /i\/o timeout/i,
  /transport: /i
]

var TLS_PATTERNS = [
  /x509/i,
  /tls: /i,
  /certificate (signed by unknown authority|has expired|is not valid)/i,
  /bad certificate/i,
  /remote error: tls/i
]

function matchesAny(patterns, text) {
  for (var i = 0; i < patterns.length; i++) if (patterns[i].test(text)) return true
  return false
}

// `context` is optional and only shapes the wording: { namespace, operation }.
//
// Returns:
//   kind      auth | denied | tls | network | timeout | notFound | server | unknown
//   message   what the panel shows -- short, and says what to do where it can
//   detail    the original text, for doctor and the journal
//   reauth    worth resolving apiKeyCommand again and retrying once
function classifyError(body, status, context) {
  var ctx = context || {}
  var raw = String(body === undefined || body === null ? "" : body)
  var code = 0
  var text = raw

  // The API reports errors as {code, message, details}; a proxy in front of it
  // reports an HTML page, and the CLI reports a line of Go.
  try {
    var parsed = JSON.parse(raw)
    if (parsed && parsed.message) {
      text = String(parsed.message)
      code = Number(parsed.code) || 0
    }
  } catch (error) {
    // not JSON -- the raw text is the best evidence there is
  }

  var httpStatus = Number(status) || 0

  if (httpStatus === 401 || code === 16 || matchesAny(AUTH_PATTERNS, text)) {
    return classified("auth", authRejectedText(ctx), text, true)
  }
  if (httpStatus === 403 || code === 7 || matchesAny(DENIED_PATTERNS, text)) {
    return classified("denied", deniedText(ctx, text), text, false)
  }
  if (matchesAny(TLS_PATTERNS, text)) {
    return classified("tls", "tls handshake failed: " + firstLine(text), text, false)
  }
  if (httpStatus === 404 || code === 5) {
    return classified("notFound", ctx.namespace ? "no namespace " + ctx.namespace : "not found", text, false)
  }
  if (/timed out|no response in/i.test(text)) {
    return classified("timeout", firstLine(text) || "timed out", text, false)
  }
  if (httpStatus === 0 && text === "") {
    return classified("network", "unreachable", text, false)
  }
  if (matchesAny(NETWORK_PATTERNS, text)) {
    return classified("network", firstLine(text), text, false)
  }
  if (httpStatus >= 500) {
    return classified("server", "server error (HTTP " + httpStatus + ")", text, false)
  }
  if (text !== "") return classified("unknown", firstLine(text), text, false)
  if (httpStatus !== 0) return classified("unknown", "HTTP " + httpStatus, text, false)
  return classified("network", "unreachable", text, false)
}

function classified(kind, message, detail, reauth) {
  return { kind: kind, message: message, detail: detail, reauth: reauth === true, auth: isAuthKind(kind) }
}

function isAuthKind(kind) {
  return kind === "auth" || kind === "denied"
}

function firstLine(text) {
  var lines = String(text || "").split("\n")
  var line = ""
  for (var i = 0; i < lines.length && line === ""; i++) line = lines[i].trim()
  if (line === "") return ""
  return line.length <= 160 ? line : line.substring(0, 157) + "..."
}

// 401 means the credential itself was not accepted. Saying which credential is
// the whole value of the message: "unauthorized" sends people to the server
// logs, "token rejected" sends them to their token.
function authRejectedText(ctx) {
  if (ctx.refreshed) return "token still rejected after refreshing it"
  if (ctx.namespace) return "token rejected for " + ctx.namespace + " — expired, or not permitted here"
  return "token rejected — expired, or not a key for this server"
}

// 403 means the credential is real and does not cover this. Naming the
// namespace turns a dead end into a request someone can make of their admin.
function deniedText(ctx, text) {
  // Not an authorization failure at all: frontend.httpAllowedHosts rejects the
  // Host header with the same code 7 a refused namespace uses, and hunting for
  // a missing permission that was never the problem costs an afternoon.
  if (/host not allowed/i.test(String(text || ""))) {
    return "the server refused this Host header — see frontend.httpAllowedHosts"
  }
  if (ctx.operation === "listNamespaces") return "no permission to list namespaces"
  if (ctx.namespace) return "no permission for namespace " + ctx.namespace
  return "no permission for this operation"
}

// --- namespace-level authorization -------------------------------------------------
//
// A credential scoped to two namespaces can read both of them and still be
// refused ListNamespaces, because listing is a cluster-level call. Failing the
// whole server for that hides data the token is perfectly entitled to.

function namespaceFallback(server, previousNames, classification) {
  var kind = (classification && classification.kind) || "unknown"
  var why = (classification && classification.message) || "namespace discovery failed"

  var configured = (server && isList(server.namespaces)) ? server.namespaces : []
  if (configured.length > 0) {
    return {
      names: configured.slice(),
      note: "cannot list namespaces (" + why + "); using the " + configured.length
        + " configured for this server",
      fail: false,
      message: ""
    }
  }

  var previous = isList(previousNames) ? previousNames : []
  if (previous.length > 0) {
    return {
      names: previous.slice(),
      note: "cannot list namespaces (" + why + "); still showing the "
        + previous.length + " from the last poll that could",
      fail: false,
      message: ""
    }
  }

  // Nothing to fall back to. For an authorization failure that is a config
  // problem with a known fix, so say the fix rather than the symptom.
  if (isAuthKind(kind)) {
    return {
      names: [],
      note: "",
      fail: true,
      message: why + ". Add \"namespaces\": [\"…\"] to this server so it "
        + "reads them directly instead of listing them."
    }
  }
  return { names: [], note: "", fail: true, message: why }
}

// --- redaction -------------------------------------------------------------------
//
// Error text goes to the panel, to `omtemporal doctor` and to the journal. A
// token that reaches any of those has leaked, and the ways it can get in there
// are not all ours -- a Go client will happily print the header it sent.

var REDACTED = "••••"

function redact(text, secrets) {
  var out = String(text === undefined || text === null ? "" : text)
  var list = isList(secrets) ? secrets : [secrets]
  for (var i = 0; i < list.length; i++) {
    var secret = String(list[i] || "")
    // Short values are not credentials, and blanking them would mangle the
    // message for no gain.
    if (secret.length < 8) continue
    while (out.indexOf(secret) !== -1) out = out.replace(secret, REDACTED)
  }
  // Anything that looks like a credential regardless of whether we know it.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1" + REDACTED)
  out = out.replace(/(--api-key[= ])[^\s"']{8,}/gi, "$1" + REDACTED)
  out = out.replace(/(Authorization:\s*\S+\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1" + REDACTED)
  return out
}

// Every secret a server could put into a message, for redact().
function serverSecrets(server, resolvedKey) {
  var out = []
  if (!server) return out
  if (server.apiKey) out.push(String(server.apiKey))
  if (resolvedKey) out.push(String(resolvedKey))
  var headers = server.headers || {}
  for (var name in headers) if (String(headers[name]).length >= 8) out.push(String(headers[name]))
  return out
}

// --- doctor ---------------------------------------------------------------------
//
// `omtemporal doctor` is what people run when the panel is empty, and auth is
// now the most likely reason it is. One line per server, plus every issue the
// config already tells us about, plus how the last poll actually went.

function authReport(servers, serverStates) {
  var list = isList(servers) ? servers : []
  if (list.length === 0) return "no servers configured"

  var states = isList(serverStates) ? serverStates : []
  var lines = []
  for (var i = 0; i < list.length; i++) {
    var server = list[i]
    var summary = authSummary(server)
    var state = i < states.length ? states[i] : null

    var verdict = "ok"
    var detail = summary.text
    if (state && state.ok === false) {
      verdict = isAuthKind(String(state.errorKind || "")) ? "auth" : "down"
      detail = summary.text + " — " + String(state.error || "")
    } else if (state && state.notice) {
      verdict = "partial"
      detail = summary.text + " — " + String(state.notice)
    } else if (state && state.pending) {
      verdict = "pending"
    }

    lines.push([server.label, server.transport, verdict, detail].join("\t"))

    var issues = authConfigIssues(server)
    for (var j = 0; j < issues.length; j++) {
      lines.push(["", "", issues[j].level, issues[j].text].join("\t"))
    }
    // Paths are checked by the shell script, which can actually stat them; this
    // just tells it which ones matter for this server.
    var tls = server.tls || normalizeTls({})
    if (tls.certPath) lines.push(["", "", "file", "tlsCertPath\t" + tls.certPath].join("\t"))
    if (tls.keyPath) lines.push(["", "", "file", "tlsKeyPath\t" + tls.keyPath].join("\t"))
    if (tls.caPath) lines.push(["", "", "file", "tlsCaPath\t" + tls.caPath].join("\t"))
    if (server.apiKeyCommand) lines.push(["", "", "command", "apiKeyCommand\t" + server.apiKeyCommand].join("\t"))
  }
  return lines.join("\n")
}

// --- response parsing ---------------------------------------------------------

function parseNamespaceList(json) {
  var out = []
  var items = unwrap(json, "namespaces")
  for (var i = 0; i < items.length; i++) {
    var info = items[i] ? items[i].namespaceInfo : null
    var name = info ? String(info.name || "") : ""
    if (name === "" || isInternalNamespace(name)) continue
    out.push(name)
  }
  out.sort()
  return out
}

function parseNamespaceDetail(json) {
  var info = (json && json.namespaceInfo) || {}
  var config = (json && json.config) || {}
  return {
    name: String(info.name || ""),
    state: shortEnum(info.state, "NAMESPACE_STATE_"),
    description: String(info.description || ""),
    owner: String(info.ownerEmail || ""),
    retention: durationText(config.workflowExecutionRetentionTtl)
  }
}

function parseClusterInfo(json) {
  if (!json) return null
  var versionInfo = json.versionInfo || {}
  var recommended = (versionInfo.recommended && versionInfo.recommended.version) || ""
  var current = String(json.serverVersion || (versionInfo.current && versionInfo.current.version) || "")
  return {
    serverVersion: current,
    clusterName: String(json.clusterName || ""),
    persistenceStore: String(json.persistenceStore || ""),
    visibilityStore: String(json.visibilityStore || ""),
    historyShardCount: Number(json.historyShardCount || 0),
    recommendedVersion: recommended && recommended !== current ? String(recommended) : ""
  }
}

// Grouped counts differ by transport and this is the only place that cares:
// HTTP returns protobuf Payloads with the status base64-encoded in
// `groupValues[0].data`; the CLI has already decoded them to plain strings.
function parseCounts(json) {
  var counts = {}
  var total = 0
  if (!json) return { counts: counts, total: total }

  var groups = isList(json.groups) ? json.groups : []
  for (var i = 0; i < groups.length; i++) {
    var group = groups[i]
    var values = group && isList(group.groupValues) ? group.groupValues : []
    if (values.length === 0) continue
    var key = statusKey(decodeGroupValue(values[0]))
    var n = parseInt(group.count, 10)
    if (!isFinite(n)) n = 0
    counts[key] = (counts[key] || 0) + n
    total += n
  }

  // A namespace with no executions returns a bare count and no groups.
  if (groups.length === 0) {
    var bare = parseInt(json.count, 10)
    total = isFinite(bare) ? bare : 0
  }
  return { counts: counts, total: total }
}

function decodeGroupValue(value) {
  if (typeof value === "string") return value
  if (!value || !value.data) return ""
  try {
    // The payload is json/plain, so a status arrives quoted: "Running".
    return JSON.parse(decodeBase64(String(value.data)))
  } catch (error) {
    return ""
  }
}

// Flatten one ListWorkflowExecutions response into rows the panel can draw
// without reaching back into the raw JSON.
function parseExecutions(json, server, namespace) {
  var rows = []
  var items = unwrap(json, "executions")
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {}
    var execution = item.execution || {}
    var workflowId = String(execution.workflowId || "")
    if (workflowId === "") continue

    var runId = String(execution.runId || "")
    rows.push({
      kind: "workflow",
      workflowId: workflowId,
      runId: runId,
      type: String((item.type && item.type.name) || "Workflow"),
      status: statusKey(item.status),
      taskQueue: String(item.taskQueue || ""),
      startTime: String(item.startTime || ""),
      closeTime: String(item.closeTime || ""),
      startMs: parseTime(item.startTime),
      namespace: namespace,
      serverLabel: server.label,
      serverIndex: server.index,
      url: workflowUiUrl(server.uiUrl || server.url, namespace, workflowId, runId)
    })
  }
  return rows
}

// DescribeWorkflowExecution. `pendingActivities` is the payload that answers
// "why is this Workflow not finishing" -- attempt counts, the last failure, and
// when the next retry is due.
function parseWorkflowDetail(json) {
  if (!json) return null
  var info = json.workflowExecutionInfo || {}
  var execution = info.execution || {}
  return {
    workflowId: String(execution.workflowId || ""),
    runId: String(execution.runId || ""),
    type: String((info.type && info.type.name) || ""),
    status: statusKey(info.status),
    taskQueue: String(info.taskQueue || ""),
    startTime: String(info.startTime || ""),
    closeTime: String(info.closeTime || ""),
    startMs: parseTime(info.startTime),
    closeMs: parseTime(info.closeTime),
    historyLength: Number(info.historyLength || 0),
    parent: info.parentExecution ? String(info.parentExecution.workflowId || "") : "",
    activities: parsePendingActivities(json)
  }
}

function parsePendingActivities(json) {
  var out = []
  var items = unwrap(json, "pendingActivities")
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {}
    var attempt = Number(item.attempt || 1)
    var failure = item.lastFailure ? String(item.lastFailure.message || "") : ""
    out.push({
      kind: "activity",
      activityId: String(item.activityId || ""),
      type: String((item.activityType && item.activityType.name) || "Activity"),
      state: shortEnum(item.state, "PENDING_ACTIVITY_STATE_"),
      attempt: attempt,
      maximumAttempts: Number(item.maximumAttempts || 0),
      lastFailure: failure,
      scheduledMs: parseTime(item.scheduledTime),
      lastStartedMs: parseTime(item.lastStartedTime),
      lastHeartbeatMs: parseTime(item.lastHeartbeatTime),
      // While an activity is backing off, its next attempt is what
      // `scheduledTime` points at -- the most useful number on the row.
      retryAtMs: attempt > 1 ? parseTime(item.scheduledTime) : 0,
      // A retrying activity is the single most useful thing this panel can
      // point at, so it gets the urgent treatment a failure does.
      troubled: attempt > 1 || failure !== ""
    })
  }
  return out
}

// DescribeTaskQueue. Pollers are the honest answer to "is a worker running?" --
// worker heartbeats are opt-in per SDK and mostly absent.
function parseTaskQueue(json, name, defaultType) {
  var pollers = []
  var items = unwrap(json, "pollers")
  for (var i = 0; i < items.length; i++) {
    var poller = items[i] || {}
    pollers.push({
      kind: "worker",
      identity: String(poller.identity || "unknown"),
      // DescribeTaskQueue over HTTP is asked about one side at a time and does
      // not echo which, so the caller supplies it.
      taskQueueType: shortEnum(poller.taskQueueType, "TASK_QUEUE_TYPE_") || String(defaultType || ""),
      buildId: String(poller.buildId || ""),
      lastAccessMs: parseTime(poller.lastAccessTime),
      ratePerSecond: Number(poller.ratePerSecond || 0)
    })
  }

  var backlog = 0
  var addRate = 0
  var stats = unwrap(json, "stats")
  for (var j = 0; j < stats.length; j++) {
    backlog += Number(stats[j].approximateBacklogCount || 0)
    addRate += Number(stats[j].tasksAddRate || 0)
  }

  return {
    kind: "taskQueue",
    name: String(name || ""),
    pollers: pollers,
    backlog: backlog,
    addRate: addRate
  }
}

// Fold the activity side of a queue into the workflow side.
function mergeTaskQueue(base, extra) {
  if (!base) return extra
  if (!extra) return base
  var pollers = base.pollers.slice()
  for (var i = 0; i < extra.pollers.length; i++) {
    var candidate = extra.pollers[i]
    var duplicate = false
    for (var j = 0; j < pollers.length; j++) {
      if (pollers[j].identity === candidate.identity
        && pollers[j].taskQueueType === candidate.taskQueueType) duplicate = true
    }
    if (!duplicate) pollers.push(candidate)
  }
  return {
    kind: "taskQueue",
    name: base.name,
    pollers: pollers,
    backlog: base.backlog + extra.backlog,
    addRate: base.addRate + extra.addRate
  }
}

function parseSchedules(json) {
  var out = []
  var items = unwrap(json, "schedules")
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {}
    var info = item.info || {}
    var future = isList(info.futureActionTimes) ? info.futureActionTimes
      : (isList(item.futureActionTimes) ? item.futureActionTimes : [])
    var recent = isList(info.recentActions) ? info.recentActions : []
    out.push({
      kind: "schedule",
      scheduleId: String(item.scheduleId || ""),
      paused: (info.paused === true) || (item.paused === true),
      notes: String(info.notes || ""),
      workflowType: String((info.workflowType && info.workflowType.name) || ""),
      spec: describeScheduleSpec(info.spec || item.spec),
      nextMs: future.length > 0 ? parseTime(future[0]) : 0,
      recentCount: recent.length
    })
  }
  return out
}

// Schedule specs come in three flavours; this reduces whichever is present to
// one short phrase rather than trying to render the full grammar.
function describeScheduleSpec(spec) {
  if (!spec) return ""
  var intervals = isList(spec.interval) ? spec.interval : []
  if (intervals.length > 0 && intervals[0].interval) return "every " + durationText(intervals[0].interval)
  var crons = isList(spec.cronString) ? spec.cronString : []
  if (crons.length > 0) return String(crons[0])
  var calendars = isList(spec.calendar) ? spec.calendar
    : (isList(spec.structuredCalendar) ? spec.structuredCalendar : [])
  if (calendars.length > 0) return "calendar"
  return ""
}

function parseBatchOperations(json) {
  var out = []
  var items = unwrap(json, "operationInfo")
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {}
    out.push({
      kind: "batch",
      jobId: String(item.jobId || ""),
      state: shortEnum(item.state, "BATCH_OPERATION_STATE_"),
      startMs: parseTime(item.startTime),
      closeMs: parseTime(item.closeTime)
    })
  }
  return out
}

// Every distinct task queue named by the executions already fetched. There is
// no list-task-queues endpoint, and these are the queues that demonstrably have
// work on them, which is the set worth showing anyway.
function taskQueuesFromExecutions(workflows) {
  var seen = {}
  var out = []
  var rows = isList(workflows) ? workflows : []
  for (var i = 0; i < rows.length; i++) {
    var name = String(rows[i].taskQueue || "")
    if (name === "" || seen[name]) continue
    seen[name] = true
    out.push(name)
  }
  out.sort()
  return out
}

// The one-line form of classifyError, kept because most callers only want the
// string. Anything that has to branch on *why* -- retrying after a token
// refresh, falling back to the configured namespaces -- calls classifyError
// itself and reads the kind.
function errorMessage(body, status, context) {
  return classifyError(body, status, context).message
}

// --- formatting ----------------------------------------------------------------

function shortEnum(value, prefix) {
  var text = String(value || "")
  if (text === "") return ""
  if (prefix && text.indexOf(prefix) === 0) text = text.substring(prefix.length)
  var words = text.split("_")
  var out = ""
  for (var i = 0; i < words.length; i++) out += (i > 0 ? " " : "") + titleCase(words[i])
  return out
}

function parseTime(value) {
  if (!value) return 0
  var ms = Date.parse(String(value))
  return isFinite(ms) ? ms : 0
}

// Protobuf durations arrive as "86400s" or "0.5s".
function durationText(value) {
  var text = String(value || "")
  if (text === "") return ""
  var seconds = parseFloat(text)
  if (!isFinite(seconds)) return text
  if (seconds < 60) return Math.round(seconds) + "s"
  var minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + "m"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h"
  return Math.floor(hours / 24) + "d"
}

// Compact single-unit age, the same shape the Temporal Web UI uses in lists.
function ageText(ms, nowMs) {
  if (!ms) return ""
  var seconds = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (seconds < 60) return seconds + "s"
  var minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + "m"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h"
  var days = Math.floor(hours / 24)
  if (days < 7) return days + "d"
  return Math.floor(days / 7) + "w"
}

// "in 12s", for a moment that has not arrived yet.
function untilText(ms, nowMs) {
  if (!ms) return ""
  var seconds = Math.round((ms - nowMs) / 1000)
  if (seconds <= 0) return "due"
  if (seconds < 60) return "in " + seconds + "s"
  var minutes = Math.floor(seconds / 60)
  if (minutes < 60) return "in " + minutes + "m"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return "in " + hours + "h"
  return "in " + Math.floor(hours / 24) + "d"
}

function sortByStartDesc(rows) {
  return rows.slice().sort(function (a, b) { return b.startMs - a.startMs })
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s")
}

// --- rollups ---------------------------------------------------------------------

// One pass over the whole fleet for the numbers the bar button and the hero
// line need. Unreachable servers contribute nothing but are counted so the
// panel can say so.
function rollup(serverStates) {
  var totals = {
    running: 0,
    failed: 0,        // exact namespace totals, for the panel
    recentFailed: 0,  // bad statuses in the fetched window, for the bar
    namespaces: 0,
    servers: 0,
    down: 0,
    executions: 0
  }
  var states = isList(serverStates) ? serverStates : []

  for (var i = 0; i < states.length; i++) {
    var server = states[i] || {}
    totals.servers += 1
    if (server.ok === false && server.pending !== true) {
      totals.down += 1
      continue
    }
    var namespaces = isList(server.namespaces) ? server.namespaces : []
    for (var j = 0; j < namespaces.length; j++) {
      var namespace = namespaces[j] || {}
      var counts = namespace.counts || {}
      totals.namespaces += 1
      totals.running += counts.Running || 0
      for (var status in BAD_STATUSES) totals.failed += counts[status] || 0
      var workflows = isList(namespace.workflows) ? namespace.workflows : []
      totals.executions += workflows.length
      for (var k = 0; k < workflows.length; k++) {
        if (isBad(workflows[k].status)) totals.recentFailed += 1
      }
    }
  }
  return totals
}

// Same shape as rollup(), scoped to one server.
function serverTotals(server) {
  return rollup(server ? [server] : [])
}

function namespaceTotals(namespace) {
  var counts = (namespace && namespace.counts) || {}
  var bad = 0
  for (var status in BAD_STATUSES) bad += counts[status] || 0
  return {
    running: counts.Running || 0,
    failed: bad,
    total: (namespace && namespace.total) || 0
  }
}

// The hero's one-line summary. Reads as a sentence, and never claims a healthy
// fleet while a server is unreachable.
function summaryText(totals, refreshing) {
  if (totals.servers === 0) return "No servers configured"
  if (totals.down === totals.servers) return totals.servers === 1 ? "Server unreachable" : "All servers unreachable"

  // "running" is already a state, not a countable noun: 24 running, not 24 runnings.
  var parts = [totals.running + " running"]
  if (totals.failed > 0) parts.push(totals.failed + " failed")
  parts.push(plural(totals.namespaces, "namespace"))
  if (totals.down > 0) parts.push(totals.down + " unreachable")
  else if (refreshing && totals.executions === 0) parts.push("loading")
  return parts.join(" · ")
}

// Count chips for one namespace, already ordered and stripped of zeroes.
function countChips(counts) {
  var chips = []
  var source = counts || {}
  for (var i = 0; i < STATUS_ORDER.length; i++) {
    var key = STATUS_ORDER[i]
    var n = source[key] || 0
    if (n > 0) chips.push({ status: key, count: n, label: statusShort(key) })
  }
  return chips
}

// Gather every namespace's recent rows into one list, newest first.
function mergeExecutions(serverStates, filter, limit) {
  var rows = []
  var states = isList(serverStates) ? serverStates : []

  for (var i = 0; i < states.length; i++) {
    var namespaces = isList(states[i].namespaces) ? states[i].namespaces : []
    for (var j = 0; j < namespaces.length; j++) {
      var workflows = isList(namespaces[j].workflows) ? namespaces[j].workflows : []
      for (var k = 0; k < workflows.length; k++) {
        var row = workflows[k]
        if (filter === "open" && !isOpen(row.status)) continue
        if (filter === "failed" && !isBad(row.status)) continue
        rows.push(row)
      }
    }
  }

  rows = sortByStartDesc(rows)
  var cap = Number(limit) || 0
  return cap > 0 ? rows.slice(0, cap) : rows
}

function filterExecutions(workflows, filter) {
  var rows = isList(workflows) ? workflows : []
  var out = []
  for (var i = 0; i < rows.length; i++) {
    if (filter === "open" && !isOpen(rows[i].status)) continue
    if (filter === "failed" && !isBad(rows[i].status)) continue
    out.push(rows[i])
  }
  return sortByStartDesc(out)
}

var FILTERS = ["all", "open", "failed"]

var FILTER_LABEL = {
  all: "All",
  open: "Running",
  failed: "Needs attention"
}

function nextFilter(current) {
  var index = FILTERS.indexOf(current)
  return FILTERS[(index + 1) % FILTERS.length]
}

function namespaceKey(serverIndex, namespace) {
  return serverIndex + "/" + namespace
}

// --- routing -------------------------------------------------------------------------

// The panel is a stack of levels, each showing exactly one kind of thing. The
// route says which level is on screen and what it is scoped to; the title,
// breadcrumb and which fetch to run are all derived from it.
function routeFleet() { return { level: "fleet" } }
function routeSetup() { return { level: "setup" } }
function routeServer(serverIndex) { return { level: "server", serverIndex: serverIndex } }

function routeNamespace(serverIndex, namespace) {
  return { level: "namespace", serverIndex: serverIndex, namespace: namespace }
}

function routeWorkflow(serverIndex, namespace, workflowId, runId) {
  return {
    level: "workflow",
    serverIndex: serverIndex,
    namespace: namespace,
    workflowId: workflowId,
    runId: runId
  }
}

function routeTaskQueue(serverIndex, namespace, taskQueue) {
  return {
    level: "taskQueue",
    serverIndex: serverIndex,
    namespace: namespace,
    taskQueue: taskQueue
  }
}

// Ascending is always well-defined, so Esc never strands anyone on a level with
// no way back. null means "already at the root": there, Esc closes the panel.
function parentRoute(route) {
  if (!route) return routeFleet()
  switch (route.level) {
  case "workflow":
  case "taskQueue":
    return routeNamespace(route.serverIndex, route.namespace)
  case "namespace":
    return routeServer(route.serverIndex)
  case "server":
  case "setup":
    return routeFleet()
  default:
    return null
  }
}

// Breadcrumb segments, each carrying the glyph of the primitive it names, so
// the trail itself teaches the hierarchy.
function breadcrumb(route, serverStates) {
  var crumbs = [{ kind: "fleet", glyph: primitiveGlyph("server"), label: "Servers" }]
  if (!route || route.level === "fleet") return crumbs
  if (route.level === "setup") return crumbs.concat([{ kind: "setup", glyph: "󰒓", label: "Setup" }])

  var states = isList(serverStates) ? serverStates : []
  var server = states[route.serverIndex]
  crumbs.push({
    kind: "server",
    glyph: primitiveGlyph("server"),
    label: server ? server.label : "server"
  })
  if (route.level === "server") return crumbs

  crumbs.push({ kind: "namespace", glyph: primitiveGlyph("namespace"), label: route.namespace })
  if (route.level === "namespace") return crumbs

  if (route.level === "taskQueue") {
    crumbs.push({ kind: "taskQueue", glyph: primitiveGlyph("taskQueue"), label: route.taskQueue })
    return crumbs
  }

  crumbs.push({ kind: "workflow", glyph: primitiveGlyph("workflow"), label: route.workflowId })
  return crumbs
}

// Cache key for an on-demand fetch. Deep data is fetched when you drill in
// rather than polled for every namespace, so each request needs a stable
// identity to be stored under and looked up by.
function detailKey(route) {
  if (!route) return ""
  switch (route.level) {
  case "workflow":
    return "wf:" + route.serverIndex + "/" + route.namespace + "/" + route.workflowId + "/" + (route.runId || "")
  case "taskQueue":
    return "tq:" + route.serverIndex + "/" + route.namespace + "/" + route.taskQueue
  case "namespace":
    return "ns:" + route.serverIndex + "/" + route.namespace
  case "server":
    return "srv:" + route.serverIndex
  default:
    return ""
  }
}

function sameRoute(a, b) {
  if (!a || !b) return false
  return a.level === b.level
    && a.serverIndex === b.serverIndex
    && a.namespace === b.namespace
    && a.workflowId === b.workflowId
    && a.runId === b.runId
    && a.taskQueue === b.taskQueue
}

// --- entry builders -------------------------------------------------------------------
//
// Every level of the panel renders the same way: a flat list of entries, with a
// section header emitted wherever `section` changes. Deciding what a level
// contains therefore happens here, in plain functions, rather than in five
// near-identical QML files -- which is also what keeps a namespace looking like
// a namespace no matter where it is shown.
//
// Entry fields:
//   section/sectionHint  header text, and the one-line explainer under it
//   kind                 primitive; picks the glyph unless `glyph` overrides
//   title/subtitle       left column, two lines
//   trailing/trailingSub right column, two lines
//   tone                 "normal" | "dim" | "bad"  -> foreground | dim | urgent
//   selectable           can the cursor land on it (info rows cannot)
//   action               what Enter does; the panel switches on this
//   payload              arguments for the action

function entry(fields) {
  return {
    section: fields.section || "",
    sectionHint: fields.sectionHint || "",
    kind: fields.kind || "",
    glyph: fields.glyph !== undefined ? fields.glyph : primitiveGlyph(fields.kind),
    title: fields.title || "",
    subtitle: fields.subtitle || "",
    trailing: fields.trailing || "",
    trailingSub: fields.trailingSub || "",
    tone: fields.tone || "normal",
    selectable: fields.selectable !== false,
    action: fields.action || "",
    payload: fields.payload || null
  }
}

// An info row: shown, never selected. Used for the attributes of the thing you
// have drilled into, as opposed to the things inside it.
function infoEntry(section, label, value, tone) {
  return entry({
    section: section,
    kind: "",
    glyph: "",
    title: label,
    trailing: value,
    tone: tone || "dim",
    selectable: false
  })
}

function noteEntry(section, text, tone) {
  return entry({
    section: section,
    kind: "",
    glyph: "",
    title: text,
    tone: tone || "dim",
    selectable: false
  })
}

// --- fleet ------------------------------------------------------------------------------

function fleetEntries(serverStates, nowMs) {
  var entries = []
  var states = isList(serverStates) ? serverStates : []

  for (var i = 0; i < states.length; i++) {
    var server = states[i] || {}
    var totals = serverTotals(server)
    var reachable = server.ok !== false
    var cluster = server.cluster

    entries.push(entry({
      section: primitiveHeading("server"),
      sectionHint: primitiveHint("server"),
      kind: "server",
      title: server.label,
      subtitle: server.host + "  ·  " + (server.transport === "cli" ? "cli" : "http"),
      // "…" only when there is genuinely nothing to show yet; a refresh over
      // data we already have should not blank the row.
      trailing: !reachable
        ? failureWord(server.errorKind)
        : (server.pending && totals.namespaces === 0 ? "…" : totals.running + " running"),
      trailingSub: !reachable
        ? String(server.error || "")
        : (cluster ? "v" + cluster.serverVersion : plural(totals.namespaces, "namespace")),
      tone: reachable ? "normal" : "bad",
      selectable: true,
      action: reachable ? "openServer" : "retry",
      payload: { serverIndex: i }
    }))
  }

  entries.push(entry({
    section: "CONFIGURE",
    kind: "",
    glyph: "󰒓",
    title: "Add or remove servers",
    subtitle: "discover local servers and temporal CLI profiles",
    action: "openSetup"
  }))

  return entries
}

// The word in the corner of a server row that is not working. "unreachable" on
// a rejected token is a lie that costs an hour of tcpdump, so the kind decides
// the word and the error itself goes underneath.
function failureWord(kind) {
  switch (String(kind || "")) {
  case "auth": return "token rejected"
  case "denied": return "no permission"
  case "config": return "misconfigured"
  case "tls": return "tls failed"
  case "timeout": return "no answer"
  }
  return "unreachable"
}

// --- one server -----------------------------------------------------------------------------

function serverEntries(server, nowMs) {
  var entries = []
  if (!server) return entries

  var cluster = server.cluster
  if (cluster) {
    entries.push(entry({
      section: primitiveHeading("cluster"),
      sectionHint: primitiveHint("cluster"),
      kind: "cluster",
      title: cluster.clusterName || server.label,
      subtitle: "Temporal " + cluster.serverVersion,
      trailing: cluster.persistenceStore,
      trailingSub: cluster.visibilityStore
        && cluster.visibilityStore !== cluster.persistenceStore
        ? "visibility: " + cluster.visibilityStore : "",
      tone: "dim",
      selectable: false
    }))
    if (cluster.recommendedVersion) {
      entries.push(noteEntry(primitiveHeading("cluster"),
        "Server " + cluster.recommendedVersion + " is available", "bad"))
    }
  }

  if (server.ok === false) {
    entries.push(noteEntry("", String(server.error || "unreachable"), "bad"))
    return entries
  }

  // Said out loud rather than left to be inferred from a short list: a server
  // that fell back to its configured namespaces, or that had to move onto the
  // cli transport, is showing something other than what was asked for.
  if (server.notice) entries.push(noteEntry("", String(server.notice), "dim"))

  var namespaces = isList(server.namespaces) ? server.namespaces : []
  if (namespaces.length === 0) {
    entries.push(noteEntry(primitiveHeading("namespace"),
      server.pending ? "Loading namespaces…" : "No namespaces visible on this server."))
    return entries
  }

  for (var i = 0; i < namespaces.length; i++) {
    var namespace = namespaces[i] || {}
    var totals = namespaceTotals(namespace)
    entries.push(entry({
      section: primitiveHeading("namespace"),
      sectionHint: primitiveHint("namespace"),
      kind: "namespace",
      title: namespace.name,
      subtitle: namespace.error
        ? namespace.error
        : plural(totals.total, "execution") + " retained",
      trailing: totals.running + " running",
      trailingSub: totals.failed > 0 ? totals.failed + " failed" : "",
      tone: namespace.error ? "bad" : "normal",
      action: "openNamespace",
      payload: { serverIndex: namespace.serverIndex, namespace: namespace.name }
    }))
  }

  return entries
}

// --- one namespace ---------------------------------------------------------------------------
//
// Ordered so the infrastructure questions come before the volume: is anything
// listening, what fires on its own, and only then the executions themselves.

function namespaceEntries(namespace, detail, filter, nowMs) {
  var entries = []
  if (!namespace) return entries

  // Attributes of the namespace you drilled into, under a heading that names
  // it rather than the plural list you came from.
  var info = detail && detail.namespace ? detail.namespace : null
  if (info) {
    if (info.retention) entries.push(infoEntry("THIS NAMESPACE", "Retention", info.retention))
    if (info.state && info.state !== "Registered") entries.push(infoEntry("THIS NAMESPACE", "State", info.state, "bad"))
    if (info.owner) entries.push(infoEntry("THIS NAMESPACE", "Owner", info.owner))
    if (info.description) entries.push(infoEntry("THIS NAMESPACE", "Description", info.description))
  }

  // Task queues
  var queues = isList(namespace.taskQueues) ? namespace.taskQueues : []
  if (queues.length === 0) {
    entries.push(noteEntry(primitiveHeading("taskQueue"), "No task queue seen in recent executions."))
  } else {
    for (var i = 0; i < queues.length; i++) {
      entries.push(entry({
        section: primitiveHeading("taskQueue"),
        sectionHint: primitiveHint("taskQueue"),
        kind: "taskQueue",
        title: queues[i],
        subtitle: "workers and backlog",
        trailing: "",
        action: "openTaskQueue",
        payload: { serverIndex: namespace.serverIndex, namespace: namespace.name, taskQueue: queues[i] }
      }))
    }
  }

  // Schedules
  var schedules = detail && isList(detail.schedules) ? detail.schedules : []
  if (detail && detail.loading && schedules.length === 0) {
    entries.push(noteEntry(primitiveHeading("schedule"), "Loading…"))
  } else if (schedules.length === 0) {
    entries.push(noteEntry(primitiveHeading("schedule"), "No schedules in this namespace."))
  } else {
    for (var j = 0; j < schedules.length; j++) {
      var schedule = schedules[j]
      entries.push(entry({
        section: primitiveHeading("schedule"),
        sectionHint: primitiveHint("schedule"),
        kind: "schedule",
        title: schedule.scheduleId,
        subtitle: schedule.workflowType
          ? schedule.workflowType + (schedule.spec ? "  ·  " + schedule.spec : "")
          : schedule.spec,
        trailing: schedule.paused ? "Paused" : "Active",
        trailingSub: schedule.nextMs ? untilText(schedule.nextMs, nowMs) : "",
        tone: schedule.paused ? "dim" : "normal",
        selectable: false
      }))
    }
  }

  // Batch operations only earn a section when one exists; an empty one every
  // time would just be noise.
  var batch = detail && isList(detail.batch) ? detail.batch : []
  for (var k = 0; k < batch.length; k++) {
    entries.push(entry({
      section: primitiveHeading("batch"),
      sectionHint: primitiveHint("batch"),
      kind: "batch",
      title: batch[k].jobId,
      trailing: batch[k].state,
      trailingSub: batch[k].startMs ? ageText(batch[k].startMs, nowMs) : "",
      tone: "dim",
      selectable: false
    }))
  }

  // Workflows
  var workflows = filterExecutions(namespace.workflows, filter)
  if (workflows.length === 0) {
    entries.push(noteEntry(primitiveHeading("workflow"), "Nothing matches the current filter."))
  } else {
    for (var m = 0; m < workflows.length; m++) {
      entries.push(workflowEntry(workflows[m], primitiveHeading("workflow"), nowMs, false))
    }
  }

  return entries
}

function workflowEntry(row, section, nowMs, showNamespace) {
  return entry({
    section: section,
    sectionHint: primitiveHint("workflow"),
    kind: "workflow",
    glyph: statusGlyph(row.status),
    title: row.type,
    subtitle: row.workflowId,
    trailing: statusLabel(row.status),
    trailingSub: (showNamespace ? row.serverLabel + "/" + row.namespace + "  ·  " : "")
      + ageText(row.startMs, nowMs),
    tone: isBad(row.status) ? "bad" : (isOpen(row.status) ? "normal" : "dim"),
    action: "openWorkflow",
    payload: {
      serverIndex: row.serverIndex,
      namespace: row.namespace,
      workflowId: row.workflowId,
      runId: row.runId,
      url: row.url
    }
  })
}

// --- one workflow ------------------------------------------------------------------------------

function workflowDetailEntries(detail, route, nowMs) {
  var entries = []
  var workflow = detail ? detail.workflow : null

  if (!workflow) {
    entries.push(noteEntry("EXECUTION", detail && detail.loading ? "Loading…" : (detail && detail.error ? detail.error : "No detail available."),
      detail && detail.error ? "bad" : "dim"))
    return entries
  }

  var closed = workflow.closeMs > 0
  entries.push(entry({
    section: "EXECUTION",
    sectionHint: primitiveHint("workflow"),
    kind: "workflow",
    glyph: statusGlyph(workflow.status),
    title: workflow.type,
    subtitle: workflow.workflowId,
    trailing: statusLabel(workflow.status),
    trailingSub: closed
      ? "ran " + ageText(workflow.startMs, workflow.closeMs)
      : "started " + ageText(workflow.startMs, nowMs) + " ago",
    tone: isBad(workflow.status) ? "bad" : (isOpen(workflow.status) ? "normal" : "dim"),
    action: "openInBrowser",
    payload: { url: route ? route.url : "" }
  }))

  entries.push(infoEntry("EXECUTION", "Task queue", workflow.taskQueue))
  entries.push(infoEntry("EXECUTION", "History events", String(workflow.historyLength)))
  if (workflow.runId) entries.push(infoEntry("EXECUTION", "Run", workflow.runId))
  if (workflow.parent) entries.push(infoEntry("EXECUTION", "Parent", workflow.parent))

  var activities = isList(workflow.activities) ? workflow.activities : []
  if (activities.length === 0) {
    entries.push(noteEntry(primitiveHeading("activity"),
      isOpen(workflow.status)
        ? "No activity in flight — the Workflow is waiting on a timer or a signal."
        : "This execution has finished, so nothing is pending."))
    return entries
  }

  for (var i = 0; i < activities.length; i++) {
    var activity = activities[i]
    var attempts = activity.maximumAttempts > 0
      ? activity.attempt + "/" + activity.maximumAttempts
      : "attempt " + activity.attempt
    entries.push(entry({
      section: primitiveHeading("activity"),
      sectionHint: primitiveHint("activity"),
      kind: "activity",
      title: activity.type,
      // The last failure is the whole reason to look at this screen, so it
      // takes the subtitle rather than being tucked away.
      subtitle: activity.lastFailure || activity.activityId,
      trailing: activity.state,
      trailingSub: activity.retryAtMs
        ? "retry " + untilText(activity.retryAtMs, nowMs)
        : (activity.attempt > 1 ? attempts : ""),
      tone: activity.troubled ? "bad" : "normal",
      selectable: false
    }))
  }

  return entries
}

// --- one task queue -------------------------------------------------------------------------------

function taskQueueEntries(detail, nowMs) {
  var entries = []
  var queue = detail ? detail.taskQueue : null

  if (!queue) {
    entries.push(noteEntry(primitiveHeading("worker"),
      detail && detail.loading ? "Loading…" : (detail && detail.error ? detail.error : "No detail available."),
      detail && detail.error ? "bad" : "dim"))
    return entries
  }

  var pollers = isList(queue.pollers) ? queue.pollers : []
  if (pollers.length === 0) {
    // The single most valuable diagnosis this panel can offer: tasks are piling
    // up because nothing is on the other end.
    entries.push(noteEntry(primitiveHeading("worker"),
      "No workers polling this queue. Nothing will make progress.", "bad"))
  } else {
    for (var i = 0; i < pollers.length; i++) {
      var poller = pollers[i]
      entries.push(entry({
        section: primitiveHeading("worker"),
        sectionHint: primitiveHint("worker"),
        kind: "worker",
        title: poller.identity,
        subtitle: poller.taskQueueType
          ? poller.taskQueueType.toLowerCase() + " tasks"
          : (poller.buildId && poller.buildId !== "UNVERSIONED" ? "build " + poller.buildId : ""),
        trailing: poller.taskQueueType,
        trailingSub: poller.lastAccessMs ? "seen " + ageText(poller.lastAccessMs, nowMs) + " ago" : "",
        tone: "normal",
        selectable: false
      }))
    }
  }

  entries.push(infoEntry(primitiveHeading("taskQueue"), "Backlog",
    String(queue.backlog), queue.backlog > 0 ? "bad" : "dim"))
  entries.push(infoEntry(primitiveHeading("taskQueue"), "Tasks added",
    queue.addRate > 0 ? queue.addRate.toFixed(2) + "/s" : "0/s"))

  return entries
}

// --- cursor over a mixed list ------------------------------------------------------------------------

// Info rows are shown but never selected, so the cursor has to hop over them
// rather than land on a row where Enter does nothing.
function nextSelectable(entries, from, delta) {
  var list = isList(entries) ? entries : []
  if (list.length === 0) return -1
  var index = from
  for (var steps = 0; steps < list.length; steps++) {
    index += delta
    if (index < 0 || index >= list.length) return clampSelectable(list, from)
    if (list[index].selectable) return index
  }
  return clampSelectable(list, from)
}

function firstSelectable(entries) {
  var list = isList(entries) ? entries : []
  for (var i = 0; i < list.length; i++) if (list[i].selectable) return i
  return -1
}

function clampSelectable(entries, index) {
  var list = isList(entries) ? entries : []
  if (index >= 0 && index < list.length && list[index].selectable) return index
  return firstSelectable(list)
}

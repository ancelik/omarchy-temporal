// Prove that Model.js parses the HTTP API and the CLI into the same thing.
//
// The plugin deliberately keeps one parsing layer for both transports, which is
// only safe while the two really do agree. This fetches the same data both ways
// from the running test bed and compares the parsed output field by field.
//
//   node testbed/parity-test.mjs
//
// Requires the test bed to be up and `temporal` on PATH.

import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const HTTP = process.env.OMT_HTTP || "http://localhost:7243"
const GRPC = process.env.OMT_GRPC || "localhost:7233"
const NS = process.env.OMT_NS || "orders"

// Model.js is a QML .js include, not a module: it has no exports and expects to
// be evaluated into an existing scope. Wrapping it in a Function and asking for
// the names back is the least invasive way to reach it from node.
const source = readFileSync(join(here, "..", "Model.js"), "utf8")
const EXPORTS = [
  "parseCounts", "parseExecutions", "parseNamespaceList", "parseWorkflowDetail",
  "parseTaskQueue", "parseSchedules", "parseClusterInfo", "parseBatchOperations",
  "statusKey", "normalizeServers", "serversToConfig", "breadcrumb", "parentRoute",
  "routeWorkflow", "detailKey", "taskQueuesFromExecutions", "mergeTaskQueue",
  "fleetEntries", "serverEntries", "namespaceEntries", "workflowDetailEntries",
  "taskQueueEntries", "firstSelectable", "nextSelectable", "primitiveGlyph",
  "authSummary", "authConfigIssues", "hasConfigError", "httpHeaders", "authSpec",
  "classifyError", "errorMessage", "namespaceFallback", "redact", "serverSecrets",
  "authReport", "failureWord", "normalizeServer", "clusterUrl", "namespacesUrl",
  "countUrl", "parseAddSpec", "addVerdict"
]
const Model = new Function(`${source}\nreturn {${EXPORTS.join(",")}}`)()

const SERVER = { index: 0, label: "test", uiUrl: "http://localhost:8233", url: HTTP }

let failures = 0
let checks = 0

function check(name, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok    ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}\n        http: ${a}\n        cli:  ${e}`)
  }
}

async function http(path, params = {}) {
  const url = new URL(HTTP + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

function cli(args) {
  const out = execFileSync("temporal", [...args, "--address", GRPC, "-o", "json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  })
  return JSON.parse(out)
}

console.log(`parity: ${HTTP} vs ${GRPC}, namespace ${NS}\n`)

// --- namespaces ----------------------------------------------------------------

console.log("namespaces")
check(
  "namespace list",
  Model.parseNamespaceList(await http("/api/v1/namespaces", { pageSize: 100 })),
  Model.parseNamespaceList(cli(["operator", "namespace", "list"]))
)

// --- counts ---------------------------------------------------------------------
// The one place the transports genuinely differ: HTTP returns base64 protobuf
// payloads for the group values, the CLI returns plain strings.

console.log("\ncounts (base64 payloads vs plain strings)")
const httpCounts = Model.parseCounts(
  await http(`/api/v1/namespaces/${NS}/workflow-count`, { query: "GROUP BY ExecutionStatus" })
)
const cliCounts = Model.parseCounts(cli(["workflow", "count", "-n", NS, "-q", "GROUP BY ExecutionStatus"]))
// Counts move constantly on a live seeder, so compare the shape, not the values.
check("status keys", Object.keys(httpCounts.counts).sort(), Object.keys(cliCounts.counts).sort())
check("counts are numeric", Object.values(httpCounts.counts).every(Number.isFinite), true)
check("total is numeric", Number.isFinite(httpCounts.total), true)

// --- executions -------------------------------------------------------------------

console.log("\nexecutions (keyed object vs bare array)")
const httpRows = Model.parseExecutions(
  await http(`/api/v1/namespaces/${NS}/workflows`, { pageSize: 5 }), SERVER, NS
)
const cliRows = Model.parseExecutions(cli(["workflow", "list", "-n", NS, "--limit", "5"]), SERVER, NS)
check("both parsed some rows", httpRows.length > 0 && cliRows.length > 0, true)
check("row keys", Object.keys(httpRows[0]).sort(), Object.keys(cliRows[0]).sort())
check("statuses are known", httpRows.every(r => r.status !== "Unknown"), true)
check("ui urls built", httpRows.every(r => r.url.includes("/history")), true)
check("task queues extracted", Model.taskQueuesFromExecutions(httpRows).length > 0, true)

// --- workflow detail + pending activities --------------------------------------------

console.log("\nworkflow detail + pending activities")
const running = cli(["workflow", "list", "-n", NS, "-q", 'ExecutionStatus = "Running"', "--limit", "1"])
if (running.length > 0) {
  const wid = running[0].execution.workflowId
  const httpDetail = Model.parseWorkflowDetail(
    await http(`/api/v1/namespaces/${NS}/workflows/${encodeURIComponent(wid)}`)
  )
  const cliDetail = Model.parseWorkflowDetail(cli(["workflow", "describe", "-n", NS, "-w", wid]))
  check("detail keys", Object.keys(httpDetail).sort(), Object.keys(cliDetail).sort())
  check("same workflow id", httpDetail.workflowId, cliDetail.workflowId)
  check("same status", httpDetail.status, cliDetail.status)
  check("same activity count", httpDetail.activities.length, cliDetail.activities.length)
  if (httpDetail.activities.length > 0) {
    check("activity keys", Object.keys(httpDetail.activities[0]).sort(), Object.keys(cliDetail.activities[0]).sort())
    check("activity type", httpDetail.activities[0].type, cliDetail.activities[0].type)
  } else {
    console.log("  skip  no pending activities in flight right now")
  }
} else {
  console.log("  skip  nothing running to describe")
}

// --- task queue ----------------------------------------------------------------------

console.log("\ntask queue")
const httpTq = Model.parseTaskQueue(
  await http(`/api/v1/namespaces/${NS}/task-queues/omtemporal`, {
    taskQueueType: "TASK_QUEUE_TYPE_WORKFLOW", reportStats: "true", reportPollers: "true"
  }), "omtemporal"
)
const cliTq = Model.parseTaskQueue(cli(["task-queue", "describe", "-n", NS, "--task-queue", "omtemporal"]), "omtemporal")
check("task queue keys", Object.keys(httpTq).sort(), Object.keys(cliTq).sort())
check("http reports pollers", httpTq.pollers.length > 0, true)
check("cli reports pollers", cliTq.pollers.length > 0, true)
if (httpTq.pollers.length > 0) {
  check("poller keys", Object.keys(httpTq.pollers[0]).sort(), Object.keys(cliTq.pollers[0]).sort())
}

// --- schedules -------------------------------------------------------------------------

console.log("\nschedules")
const httpSched = Model.parseSchedules(await http(`/api/v1/namespaces/${NS}/schedules`, { maximumPageSize: 10 }))
const cliSched = Model.parseSchedules(cli(["schedule", "list", "-n", NS]))
check("same schedule count", httpSched.length, cliSched.length)
if (httpSched.length > 0) {
  check("schedule keys", Object.keys(httpSched[0]).sort(), Object.keys(cliSched[0]).sort())
  check("same schedule ids", httpSched.map(s => s.scheduleId).sort(), cliSched.map(s => s.scheduleId).sort())
}

// --- cluster ----------------------------------------------------------------------------

console.log("\ncluster")
const httpCluster = Model.parseClusterInfo(await http("/api/v1/cluster-info"))
const cliCluster = Model.parseClusterInfo(cli(["operator", "cluster", "describe"]))
check("server version", httpCluster.serverVersion, cliCluster.serverVersion)
check("cluster name", httpCluster.clusterName, cliCluster.clusterName)
check("persistence store", httpCluster.persistenceStore, cliCluster.persistenceStore)

// --- pure logic, no server needed -----------------------------------------------------------

console.log("\nconfig + routing")
check(
  "transport inferred from url",
  Model.normalizeServers([{ url: "http://x:7243" }])[0].transport, "http"
)
check(
  "transport inferred from address",
  Model.normalizeServers([{ address: "x:7233" }])[0].transport, "cli"
)
check(
  "QVariant-style sequence is accepted",
  Model.normalizeServers({ length: 1, 0: { url: "http://x:7243" } }).length, 1
)
check("empty means unconfigured", Model.normalizeServers(null).length, 0)
check(
  "round trip drops empty keys",
  Object.keys(Model.serversToConfig(Model.normalizeServers([{ url: "http://x:7243" }]))[0]).sort(),
  ["label", "transport", "url"]
)
check(
  "breadcrumb depth at workflow level",
  Model.breadcrumb(Model.routeWorkflow(0, "orders", "w", "r"), [{ label: "local" }]).length, 4
)
check(
  "workflow ascends to its namespace",
  Model.parentRoute(Model.routeWorkflow(0, "orders", "w", "r")).level, "namespace"
)
check("fleet has no parent", Model.parentRoute({ level: "fleet" }), null)
check(
  "detail keys are distinct per run",
  Model.detailKey(Model.routeWorkflow(0, "n", "w", "r1")) === Model.detailKey(Model.routeWorkflow(0, "n", "w", "r2")),
  false
)

// --- entry builders --------------------------------------------------------------------
//
// Every level renders from these, so a level showing the wrong kind of thing is
// a bug here rather than in the QML.

console.log("\nentry builders")
const fleetState = [{
  label: "local", host: "localhost:7243", transport: "http", ok: true, pending: false,
  cluster: { serverVersion: "1.31.2", clusterName: "active", persistenceStore: "sqlite", visibilityStore: "sqlite" },
  namespaces: [{
    name: "orders", serverIndex: 0, counts: { Running: 2, Failed: 1 }, total: 3,
    workflows: httpRows, taskQueues: ["omtemporal"]
  }]
}]
const fleet = Model.fleetEntries(fleetState, Date.now())
check("fleet lists servers then setup", fleet.map(e => e.section),
  ["SERVERS", "CONFIGURE"])
check("a server row drills in", fleet[0].action, "openServer")

const serverLevel = Model.serverEntries(fleetState[0], Date.now())
check("server level shows cluster then namespaces",
  [...new Set(serverLevel.map(e => e.section))], ["CLUSTER", "NAMESPACES"])
check("cluster row is not selectable", serverLevel[0].selectable, false)

const nsLevel = Model.namespaceEntries(fleetState[0].namespaces[0],
  { schedules: [], batch: [], namespace: { retention: "1d" }, loading: false }, "all", Date.now())
check("namespace level orders infrastructure before volume",
  [...new Set(nsLevel.map(e => e.section))],
  ["THIS NAMESPACE", "TASK QUEUES", "SCHEDULES", "WORKFLOWS"])
check("every level shows one kind per section",
  [...new Set(nsLevel.filter(e => e.section === "WORKFLOWS").map(e => e.kind))], ["workflow"])

const tqEmpty = Model.taskQueueEntries({ taskQueue: { pollers: [], backlog: 9, addRate: 0 } }, Date.now())
check("a queue with no workers is flagged urgent", tqEmpty[0].tone, "bad")
check("cursor skips info-only levels", Model.firstSelectable(tqEmpty), -1)

check("merging both sides of a queue keeps both pollers",
  Model.mergeTaskQueue(
    { name: "q", pollers: [{ identity: "a", taskQueueType: "Workflow" }], backlog: 1, addRate: 0 },
    { name: "q", pollers: [{ identity: "a", taskQueueType: "Activity" }], backlog: 2, addRate: 0 }
  ).pollers.length, 2)
check("merging is idempotent for the same poller",
  Model.mergeTaskQueue(
    { name: "q", pollers: [{ identity: "a", taskQueueType: "Workflow" }], backlog: 0, addRate: 0 },
    { name: "q", pollers: [{ identity: "a", taskQueueType: "Workflow" }], backlog: 0, addRate: 0 }
  ).pollers.length, 1)

check("distinct glyph per primitive",
  new Set(["server", "namespace", "workflow", "activity", "taskQueue", "worker", "schedule", "batch", "cluster"]
    .map(Model.primitiveGlyph)).size, 9)

// --- setBarWidget wrapper ---------------------------------------------------------------
// The shell's setBarWidget IPC drops a value that is a bare array, so the setup
// screen writes {list:[...]}. Both forms have to read back the same.

console.log("\nservers config forms")
const plain = Model.normalizeServers([{ url: "http://a:7243" }, { address: "b:7233" }])
const wrapped = Model.normalizeServers({ list: [{ url: "http://a:7243" }, { address: "b:7233" }] })
check("wrapped form matches plain form", JSON.stringify(wrapped), JSON.stringify(plain))
check("both give two servers", wrapped.length, 2)
check("transports survive", wrapped.map(s => s.transport), ["http", "cli"])


// --- authentication: config ------------------------------------------------------------
//
// Every field here is something a user writes into shell.json by hand, so the
// question each check answers is "does the config that a person would plausibly
// write mean what they meant".

console.log("\nauth config")

const bare = Model.normalizeServers([{ url: "http://x:7243" }])[0]
check("a server with no credentials says so", Model.authSummary(bare).text, "none")
check("and needs no particular transport", Model.authSummary(bare).requiresCli, false)

const keyed = Model.normalizeServers([{ url: "http://x:7243", apiKeyCommand: "pass temporal" }])[0]
check("a resolved key is described by where it comes from",
  Model.authSummary(keyed).text, "api key (command)")
check("tokens get a default lifetime", keyed.apiKeyTtlSec, 900)
check("which is overridable",
  Model.normalizeServers([{ url: "http://x:7243", apiKeyCommand: "p", apiKeyTtlSec: 60 }])[0].apiKeyTtlSec, 60)
check("and disablable with zero",
  Model.normalizeServers([{ url: "http://x:7243", apiKeyCommand: "p", apiKeyTtlSec: 0 }])[0].apiKeyTtlSec, 0)

// Headers arrive as a map from a hand-written config and as pasted lines from a
// proxy's setup page. Both have to mean the same thing.
const mapHeaders = Model.normalizeServers([{
  url: "http://x:7243", headers: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "shh" }
}])[0]
const lineHeaders = Model.normalizeServers([{
  url: "http://x:7243", headers: ["CF-Access-Client-Id: id", "CF-Access-Client-Secret= shh"]
}])[0]
check("headers read the same as a map and as lines",
  JSON.stringify(lineHeaders.headers), JSON.stringify(mapHeaders.headers))
check("two custom headers are counted, not listed",
  Model.authSummary(mapHeaders).text, "2 custom headers")
check("Accept cannot be overridden from config",
  Object.keys(Model.normalizeServers([{ url: "http://x:7243", headers: { Accept: "text/csv" } }])[0].headers).length, 0)

// mTLS is the one credential the http transport physically cannot carry.
const mtlsWithAddress = Model.normalizeServers([{
  url: "http://x:7243", address: "x:7233", transport: "http",
  tlsCertPath: "/c.pem", tlsKeyPath: "/k.pem"
}])[0]
check("a client certificate moves the server onto the cli transport",
  mtlsWithAddress.transport, "cli")
check("and says why", mtlsWithAddress.transportNote.includes("client certificate"), true)
check("with nothing left to complain about", Model.hasConfigError(mtlsWithAddress), "")

const mtlsNoAddress = Model.normalizeServers([{
  url: "http://x:7243", tlsCertPath: "/c.pem", tlsKeyPath: "/k.pem"
}])[0]
check("a client certificate with no gRPC address is a config error, not a silent failure",
  Model.hasConfigError(mtlsNoAddress).includes("address"), true)
check("half a client certificate is an error too",
  Model.hasConfigError(Model.normalizeServers([{ address: "x:7233", tlsCertPath: "/c.pem" }])[0])
    .includes("tlsKeyPath"), true)
check("a CA on its own is server verification, not mTLS, so http still works",
  Model.normalizeServers([{ url: "https://x:7243", tlsCaPath: "/ca.pem" }])[0].transport, "http")

// Temporal Cloud publishes no HTTP API; pointing the http transport at one is a
// config error with a known fix rather than a mysterious 401.
check("Temporal Cloud over http is refused with the cli spelling",
  Model.hasConfigError(Model.normalizeServers([{ url: "https://ns.acct.tmprl.cloud:7243" }])[0])
    .includes("tmprl.cloud:7233"), true)
check("a Cloud namespace missing its account suffix is flagged",
  Model.authConfigIssues(Model.normalizeServers([{
    address: "ns.acct.tmprl.cloud:7233", namespaces: ["orders"]
  }])[0]).some(i => i.text.includes("account suffix")), true)
check("but a fully qualified one is not",
  Model.authConfigIssues(Model.normalizeServers([{
    address: "ns.acct.tmprl.cloud:7233", namespaces: ["orders.acct"]
  }])[0]).some(i => i.text.includes("account suffix")), false)

check("an inline api key is a warning, never an error",
  Model.authConfigIssues(Model.normalizeServers([{ url: "https://x", apiKey: "k" }])[0])
    .map(i => i.level), ["warn"])
check("credentials over cleartext http off-box are called out",
  Model.authConfigIssues(Model.normalizeServers([{ url: "http://prod:7243", apiKeyCommand: "p" }])[0])
    .some(i => i.text.includes("plain http")), true)
check("but localhost is not nagged about",
  Model.authConfigIssues(Model.normalizeServers([{ url: "http://localhost:7243", apiKeyCommand: "p" }])[0])
    .some(i => i.text.includes("plain http")), false)

// A config that round trips is a config the setup screen can rewrite without
// quietly dropping the credentials somebody hand-edited in.
const fullConfig = {
  label: "prod", transport: "cli", address: "temporal.internal:7233",
  namespaces: ["orders"], apiKeyCommand: "pass temporal/prod", apiKeyTtlSec: 300,
  headers: { "CF-Access-Client-Id": "id" },
  tlsCertPath: "/c.pem", tlsKeyPath: "/k.pem", tlsCaPath: "/ca.pem",
  tlsServerName: "temporal.internal", tlsDisableHostVerification: true, tls: false
}
check("every auth field survives a normalize/serialize round trip",
  Model.serversToConfig(Model.normalizeServers([fullConfig]))[0], fullConfig)
check("and a server with none of them gains none of them",
  Object.keys(Model.serversToConfig(Model.normalizeServers([{ url: "http://x:7243" }]))[0]).sort(),
  ["label", "transport", "url"])

// --- the `add` command line ----------------------------------------------------------
//
// One string arrives over the IPC, already flattened: the user's shell removed
// the quotes, so a value with a space in it is several words by the time it
// gets here. Getting that wrong silently turns the rest of a key command into
// the server's label.

console.log("\nadd command line")

check("nothing is a usage line", Model.parseAddSpec("").ok, false)
check("a bare address still works",
  Model.parseAddSpec("localhost:7233").config,
  { address: "localhost:7233", transport: "cli", label: "localhost:7233" })
check("a url still infers http",
  Model.parseAddSpec("http://localhost:7243").config.transport, "http")
check("a profile still works",
  Model.parseAddSpec("profile:prod").config, { profile: "prod", transport: "cli", label: "prod" })
check("a multi-word label is still a label",
  Model.parseAddSpec("host:7233 my prod box").config.label, "my prod box")

const withCommand = Model.parseAddSpec(
  "https://temporal.corp:7243 prod apiKeyCommand=pass show temporal/prod").config
check("a key command survives having its quotes eaten by the shell",
  withCommand.apiKeyCommand, "pass show temporal/prod")
check("without swallowing the label", withCommand.label, "prod")

const withHeaders = Model.parseAddSpec(
  "https://x:7243 header=CF-Access-Client-Id: abc.access header=CF-Access-Client-Secret=shh").config
check("headers take both spellings and repeat",
  withHeaders.headers, { "CF-Access-Client-Id": "abc.access", "CF-Access-Client-Secret": "shh" })

const withTls = Model.parseAddSpec(
  "temporal.corp:7233 prod tlsCertPath=/c.pem tlsKeyPath=/k.pem tls=false").config
check("tls paths are picked up", [withTls.tlsCertPath, withTls.tlsKeyPath], ["/c.pem", "/k.pem"])
check("and a boolean option is a boolean", withTls.tls, false)

check("an inline key on the command line is warned about",
  Model.parseAddSpec("https://x:7243 apiKey=abcdefghijkl").warnings.length, 1)
check("an unknown option is treated as part of the label, not silently dropped",
  Model.parseAddSpec("host:7233 nonsense=1").config.label, "nonsense=1")

check("the verdict names the transport and the credentials",
  Model.addVerdict(Model.normalizeServer(withTls, 0), []).split("\n")[0],
  "added prod (cli, mTLS)")
check("and repeats the warnings it was given",
  Model.addVerdict(Model.normalizeServer(withTls, 0), ["careful"]).includes("warn: careful"), true)

// --- authentication: what goes on the wire ------------------------------------------

console.log("\nauth on the wire")

check("Accept is always sent", Model.httpHeaders(bare, "").Accept, "application/json")
check("a key becomes a bearer token", Model.httpHeaders(bare, "tok").Authorization, "Bearer tok")
check("no key means no Authorization header",
  Model.httpHeaders(bare, "").Authorization, undefined)
check("custom headers ride along with the token",
  Object.keys(Model.httpHeaders(mapHeaders, "tok")).sort(),
  ["Accept", "Authorization", "CF-Access-Client-Id", "CF-Access-Client-Secret"])
check("a hand-written Authorization header is left alone when there is no api key",
  Model.httpHeaders(Model.normalizeServers([{
    url: "http://x:7243", headers: { Authorization: "Basic abc" }
  }])[0], "").Authorization, "Basic abc")

const spec = Model.authSpec(Model.normalizeServers([fullConfig])[0], "resolved-key")
check("the collector spec carries the resolved key, not the command",
  spec.apiKey, "resolved-key")
check("and every tls path the CLI needs",
  [spec.tlsCertPath, spec.tlsKeyPath, spec.tlsCaPath, spec.tlsServerName, spec.tls],
  ["/c.pem", "/k.pem", "/ca.pem", "temporal.internal", false])

// --- error classification ---------------------------------------------------------------
//
// The whole point: "unreachable" and "your token expired" are different
// problems with different fixes, and both transports report them differently.

console.log("\nerror classification")

const api401 = Model.classifyError(JSON.stringify({ code: 16, message: "Jwt is missing" }), 401, {})
check("401 is an authentication failure", api401.kind, "auth")
check("worth trying a fresh token for", api401.reauth, true)
check("and says token, not network", api401.message.includes("token rejected"), true)

// Self-hosted Temporal answers *every* claim-mapping failure with code 7 and
// this exact string, so it has to be read as an authentication failure.
const vague = Model.classifyError(
  JSON.stringify({ code: 7, message: "Request unauthorized." }), 403, { namespace: "orders" })
check("Temporal's deliberately vague 403 is treated as a token problem", vague.kind, "auth")
check("and refreshing is attempted", vague.reauth, true)
check("naming the namespace it happened on", vague.message.includes("orders"), true)

const denied = Model.classifyError(
  JSON.stringify({ code: 7, message: "Caller does not have permission" }), 403, { namespace: "payments" })
check("a specific 403 is an authorization failure", denied.kind, "denied")
check("which does not burn a token refresh", denied.reauth, false)
check("and names the namespace", denied.message, "no permission for namespace payments")
check("listing namespaces gets its own wording",
  Model.classifyError('{"code":7,"message":"nope"}', 403, { operation: "listNamespaces" }).message,
  "no permission to list namespaces")

check("an allowed-hosts rejection is not mistaken for a missing permission",
  Model.classifyError('{"code":7,"message":"Host not allowed"}', 403, { namespace: "orders" })
    .message.includes("Host header"), true)

check("a second failure after a refresh says so",
  Model.classifyError("", 401, { refreshed: true }).message.includes("still rejected"), true)

// The CLI has no status code, only a line of Go on stderr.
check("the CLI's PermissionDenied is read the same way",
  Model.classifyError("rpc error: code = PermissionDenied desc = something", 0, {}).kind, "denied")
check("as is its Unauthenticated",
  Model.classifyError("error: rpc error: code = Unauthenticated desc = nope", 0, {}).kind, "auth")
check("an unreachable gRPC port is a network failure, not an auth one",
  Model.classifyError('failed reaching server: connection error: desc = "transport: Error while dialing: connection refused"', 0, {}).kind,
  "network")
check("a handshake failure is its own kind",
  Model.classifyError('transport: authentication handshake failed: tls: first record does not look like a TLS handshake', 0, {}).kind,
  "tls")
check("x509 problems too",
  Model.classifyError("x509: certificate signed by unknown authority", 0, {}).kind, "tls")
// Verbatim from the CLI with tlsCertPath pointing at nothing.
check("and a certificate path that points at nothing",
  Model.classifyError(
    "failed to build client options: invalid TLS config: failed loading client cert/key path: open /nope/c.pem: no such file or directory",
    0, {}).kind, "tls")
check("nothing at all is still unreachable", Model.classifyError("", 0, {}).kind, "network")
check("a 500 is the server's problem", Model.classifyError("", 503, {}).kind, "server")
check("the one-line form still works for callers that only want a string",
  typeof Model.errorMessage("", 0, {}), "string")
check("and an authentication failure never reads as unreachable",
  Model.errorMessage("", 401, {}) === Model.errorMessage("", 0, {}), false)

// --- namespace-level authorization ----------------------------------------------------
//
// ListNamespaces is a cluster-level call. A credential scoped to two namespaces
// can read both and still be refused it.

console.log("\nnamespace fallback")

const scoped = Model.normalizeServers([{ url: "http://x:7243", namespaces: ["orders", "payments"] }])[0]
const refusal = Model.classifyError('{"code":7,"message":"Request unauthorized."}', 403,
  { operation: "listNamespaces" })

const configured = Model.namespaceFallback(scoped, [], refusal)
check("a refused listing falls back to the configured namespaces",
  configured.names, ["orders", "payments"])
check("without failing the server", configured.fail, false)
check("and says that is what happened", configured.note.includes("cannot list namespaces"), true)

const carried = Model.namespaceFallback(bare, ["orders"], refusal)
check("with nothing configured it keeps what worked last poll", carried.names, ["orders"])
check("still not a failure", carried.fail, false)
check("and says the list is from the last poll", carried.note.includes("last poll"), true)

const nothing = Model.namespaceFallback(bare, [], refusal)
check("with nothing to fall back to the server does fail", nothing.fail, true)
check("but the message is the fix, not the symptom",
  nothing.message.includes('"namespaces"'), true)
check("a network failure gets no such advice",
  Model.namespaceFallback(bare, [], Model.classifyError("connection refused", 0, {})).message
    .includes('"namespaces"'), false)
check("a configured list beats the previous one",
  Model.namespaceFallback(scoped, ["stale"], refusal).names, ["orders", "payments"])

// --- redaction ---------------------------------------------------------------------------

console.log("\nredaction")

check("a known secret is blanked out of error text",
  Model.redact("failed with key sk-abcdefghijkl", ["sk-abcdefghijkl"]).includes("sk-abcd"), false)
check("as is a bearer token nobody told us about",
  Model.redact("sent Authorization: Bearer eyJhbGciOiJIUzI1NiJ9", []).includes("eyJhbGci"), false)
check("and an --api-key that leaked into a command echo",
  Model.redact("temporal --api-key sk-abcdefghijkl workflow list", []).includes("sk-abcd"), false)
check("short values are not mangled",
  Model.redact("namespace prod is not found", ["prod"]), "namespace prod is not found")
check("every secret a server carries is collected for redaction",
  Model.serverSecrets(mapHeaders, "resolved-token-value").sort(),
  ["id", "shh", "resolved-token-value"].filter(s => s.length >= 8).sort())

// --- doctor's report ----------------------------------------------------------------------

console.log("\nauth report")

const report = Model.authReport(
  [Model.normalizeServers([{ label: "prod", url: "https://x:7243", apiKeyCommand: "pass t" }])[0]],
  [{ ok: false, error: "token rejected", errorKind: "auth" }]
).split("\n")
check("a rejected server is reported as an auth problem, not a down one",
  report[0].split("\t")[3], "auth")
check("and the command to check is named on its own record",
  report.some(line => line.split("\t")[0] === "command" && line.includes("apiKeyCommand")), true)
check("nothing configured is its own answer", Model.authReport([], []), "no servers configured")
check("a healthy server reads ok",
  Model.authReport([bare], [{ ok: true, pending: false }]).split("\t")[3], "ok")
check("a fallback shows as partial rather than fine",
  Model.authReport([scoped], [{ ok: true, pending: false, notice: "cannot list namespaces (x)" }])
    .split("\t")[3], "partial")
// Every record starts with its type and has no empty fields, because `read`
// with IFS=tab silently merges runs of tabs and shifts every column left.
check("no record has an empty field",
  Model.authReport(
    [Model.normalizeServers([{ address: "x:7233", tlsCertPath: "/c.pem", tlsKeyPath: "/k.pem",
      apiKeyCommand: "pass t" }])[0]], []
  ).split("\n").every(line => line.split("\t").every(field => field !== "")), true)
check("and every record names its type",
  new Set(Model.authReport(
    [Model.normalizeServers([{ address: "x:7233", tlsCertPath: "/c.pem", tlsKeyPath: "/k.pem",
      apiKeyCommand: "pass t" }])[0]], []
  ).split("\n").map(line => line.split("\t")[0])),
  new Set(["server", "file", "command"]))

// --- the collector keeps credentials off argv ------------------------------------------------
//
// This is a security regression test, not a behaviour one. The api key used to
// be passed to `temporal` as --api-key, where /proc/<pid>/cmdline made it
// readable by every user on the machine, once per namespace per poll.

console.log("\ncollector argv hygiene")

// PYTHONDONTWRITEBYTECODE below, or importing the collector drops a
// __pycache__ into the plugin directory, which dev-install then copies into
// ~/.config/omarchy/plugins along with everything else.
const argvProbe = JSON.parse(execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(here, ".."))})
import collect
spec = {
    "apiKey": "SENTINEL-API-KEY",
    "address": "x:7233",
    "headers": {"CF-Access-Client-Secret": "SENTINEL-CF-SECRET"},
    "tlsCertPath": "/c.pem",
}
args = collect.connection_args(spec)
env = collect.connection_env(spec)
print(json.dumps({
    "argv": " ".join(args),
    "keyInEnv": env.get("TEMPORAL_API_KEY"),
    "headerInEnv": env.get("TEMPORAL_GRPC_META_CF_ACCESS_CLIENT_SECRET"),
    "redacted": collect.redact("temporal --api-key SENTINEL-API-KEY failed", collect.secrets_of(spec)),
}))
`], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }))

check("the api key never reaches a command line", argvProbe.argv.includes("SENTINEL-API-KEY"), false)
check("nor does a proxy header's secret", argvProbe.argv.includes("SENTINEL-CF-SECRET"), false)
check("the key goes in the environment instead", argvProbe.keyInEnv, "SENTINEL-API-KEY")
check("and so does the header", argvProbe.headerInEnv, "SENTINEL-CF-SECRET")
check("tls paths, which are not secrets, stay as flags",
  argvProbe.argv.includes("--tls-cert-path /c.pem"), true)
check("and anything that does leak into an error is blanked",
  argvProbe.redacted.includes("SENTINEL-API-KEY"), false)

// --- against a server that actually refuses ------------------------------------------------
//
// `temporal server start-dev` cannot enforce anything -- see testbed/authproxy.py
// -- so this runs against a proxy in front of it, which is also the topology the
// feature is for. Skipped when the proxy is not up.
//
//   docker compose -f testbed/compose.yaml --profile auth up -d authproxy

console.log("\nauthenticating server (proxy)")

const AUTH_HTTP = process.env.OMT_AUTH_HTTP || "http://localhost:7253"
const AUTH_TOKEN = process.env.OMT_AUTH_TOKEN || "s3cret-token-value"

const authServer = Model.normalizeServers([{
  label: "behind-a-proxy",
  url: AUTH_HTTP,
  namespaces: ["orders", "payments"],
  headers: { "CF-Access-Client-Id": "cf-client-id", "CF-Access-Client-Secret": "cf-client-secret" }
}])[0]

async function tryFetch(url, headers) {
  const res = await fetch(url, { headers })
  return { status: res.status, body: await res.text() }
}

let proxyUp = true
try {
  await tryFetch(Model.clusterUrl(AUTH_HTTP), {})
} catch (error) {
  proxyUp = false
  console.log("  skip  no authenticating proxy on " + AUTH_HTTP)
}

if (proxyUp) {
  const anonymous = await tryFetch(Model.clusterUrl(AUTH_HTTP), Model.httpHeaders(authServer, ""))
  check("without a token the proxy refuses", anonymous.status, 401)
  check("and the plugin calls it an authentication failure",
    Model.classifyError(anonymous.body, anonymous.status, {}).kind, "auth")

  const wrong = await tryFetch(Model.clusterUrl(AUTH_HTTP), Model.httpHeaders(authServer, "not-the-token"))
  check("a wrong token is refused the same way",
    Model.classifyError(wrong.body, wrong.status, {}).kind, "auth")

  const noProxyHeaders = await tryFetch(Model.clusterUrl(AUTH_HTTP),
    Model.httpHeaders(bare, AUTH_TOKEN))
  check("the right token without the proxy's headers is still refused", noProxyHeaders.status, 403)

  // The headers Model.httpHeaders builds are the ones that have to work.
  const good = await tryFetch(Model.clusterUrl(AUTH_HTTP), Model.httpHeaders(authServer, AUTH_TOKEN))
  check("token and proxy headers together get through", good.status, 200)
  check("and parse into the same cluster the direct connection sees",
    Model.parseClusterInfo(JSON.parse(good.body)).clusterName, httpCluster.clusterName)

  // The namespace-scoped case, end to end.
  const listed = await tryFetch(Model.namespacesUrl(AUTH_HTTP), Model.httpHeaders(authServer, AUTH_TOKEN))
  check("listing namespaces is refused even with a working token", listed.status, 403)
  const listFailure = Model.classifyError(listed.body, listed.status, { operation: "listNamespaces" })
  const decided = Model.namespaceFallback(authServer, [], listFailure)
  check("so the plugin falls back to the configured namespaces instead of failing the server",
    decided.fail, false)
  check("using exactly the ones that were configured", decided.names, ["orders", "payments"])

  const counted = await tryFetch(Model.countUrl(AUTH_HTTP, decided.names[0]),
    Model.httpHeaders(authServer, AUTH_TOKEN))
  check("and those namespaces really do read", counted.status, 200)
  check("into the same shape the unauthenticated server gives",
    Object.keys(Model.parseCounts(JSON.parse(counted.body))).sort(), ["counts", "total"])
}

console.log(`\n${checks - failures}/${checks} passed`)
process.exit(failures === 0 ? 0 : 1)

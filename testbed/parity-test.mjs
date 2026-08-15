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
  "taskQueueEntries", "firstSelectable", "nextSelectable", "primitiveGlyph"
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

console.log(`\n${checks - failures}/${checks} passed`)
process.exit(failures === 0 ? 0 : 1)

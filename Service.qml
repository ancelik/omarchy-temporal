import QtQuick
import QtQml
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// Data layer for the Temporal bar plugin.
//
// Two transports, one shape. `http` talks to the Temporal HTTP API with
// XMLHttpRequest; `cli` shells out to collect.py, which runs the equivalent
// `temporal` commands. Both hand their raw payloads to the same Model.js
// parsers, so nothing downstream knows or cares which one produced the data.
//
// Two kinds of fetch:
//
//   the poll     every server, every namespace: counts, recent executions,
//                cluster identity. Drives the bar, so it always runs.
//   the detail   whatever the level currently on screen needs -- pending
//                activities, task-queue pollers, schedules. Fetched on drill-in
//                only, because polling all of it for every namespace would be
//                twenty requests a tick to draw one screen.
Item {
  id: root

  property var settings: ({})

  // Set by the panel. The poll rate follows it: fast enough to feel live while
  // someone is watching, slow enough to be invisible the rest of the time.
  property bool panelOpen: false

  // The route currently on screen, so the detail fetch knows what to keep fresh.
  property var activeRoute: null

  readonly property int recentLimit: intSetting("recentLimit", 25, 5, 100)
  readonly property int requestTimeoutSec: intSetting("requestTimeoutSec", 8, 2, 60)

  readonly property var servers: Model.normalizeServers(setting("servers", null))
  readonly property bool configured: servers.length > 0

  // Shelling out costs a process start per call, so CLI servers poll no faster
  // than this however the intervals are configured.
  readonly property int cliMinIntervalSec: 15
  readonly property bool anyCli: {
    for (var i = 0; i < servers.length; i++) if (servers[i].transport === "cli") return true
    return false
  }
  readonly property int effectiveInterval: {
    var base = panelOpen
      ? intSetting("openRefreshIntervalSec", 5, 2, 600)
      : intSetting("refreshIntervalSec", 30, 5, 3600)
    return anyCli ? Math.max(base, cliMinIntervalSec) : base
  }

  property var serverStates: []
  property bool refreshing: false
  property double lastRefreshMs: 0
  readonly property var totals: Model.rollup(serverStates)

  // Deep data, keyed by Model.detailKey(route).
  property var details: ({})

  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, "")
  readonly property string collectorPath: pluginDir + "/collect.py"
  readonly property string cliPath: String(setting("cliPath", "temporal"))

  // Bumped on every poll so replies from a superseded one can be dropped
  // instead of writing stale data over fresh data.
  property int _generation: 0
  property int _detailGeneration: 0
  property var _draft: []
  property var _outstanding: ({})
  property var _inflight: []
  // Detail requests live in their own pool. Sharing the poll's pool meant every
  // poll aborted the in-flight detail fetch, and an aborted request never
  // decrements its pending count -- so the level stayed on "Loading…" forever.
  property var _detailInflight: []

  // API keys resolved from `apiKeyCommand`, keyed by server index:
  // { value: "...", at: <epoch ms>, failed: bool }. Requests wait for these:
  // firing without the header would just earn a rejection and paint a scary
  // error for the first poll of every session.
  //
  // They are re-resolved when they age past the server's apiKeyTtlSec, and once
  // more when the server rejects one. Tokens expire -- an hour is a common
  // lifetime -- and resolving once per shell session meant a panel that worked
  // all morning and was full of red by lunchtime.
  property var _apiKeys: ({})
  property int _pendingKeys: 0

  // Servers whose token has already been re-resolved for the current poll, so a
  // credential that is simply wrong surfaces instead of spinning.
  property var _authRetried: ({})
  // Servers whose last token refresh has not yet been vindicated by a good
  // response. Only used to say "still rejected", which is the difference
  // between "your token expired" and "your token is not the right token".
  property var _reauthed: ({})

  // A rejected credential must not turn into a password-manager prompt every
  // poll, so re-resolution has a floor however often the server refuses us.
  readonly property int keyRetryCooldownMs: 60000

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    if (n < min) n = min
    if (n > max) n = max
    return n
  }

  function apiKeyFor(server) {
    if (server.apiKey !== "") return server.apiKey
    var record = _apiKeys[server.index]
    return record && record.value ? String(record.value) : ""
  }

  // --- poll lifecycle -----------------------------------------------------------

  function refresh() {
    if (_pendingKeys > 0) return // the resolver calls back in
    // Expired tokens are resolved before the poll rather than after it fails,
    // so a long-lived session never shows a tick of red on the hour.
    if (resolveKeys(false)) return
    cancelInflight()

    _generation += 1
    var generation = _generation

    if (servers.length === 0) {
      _draft = []
      refreshing = false
      publish()
      return
    }

    var draft = []
    for (var i = 0; i < servers.length; i++) {
      // Carry the previous poll's data into this one. Starting each tick blank
      // makes every server flash "0 namespaces" while it refreshes -- which on
      // the cli transport is a visible second, every time.
      var previous = i < serverStates.length && serverStates[i].label === servers[i].label
        ? serverStates[i] : null
      // Credentials that cannot work as configured -- a client certificate on
      // a transport that cannot present one, an HTTP url pointed at Temporal
      // Cloud -- are reported instead of polled. Earning the same handshake
      // failure once a tick teaches nobody anything, and the message here says
      // what to change.
      var configError = Model.hasConfigError(servers[i])

      draft.push({
        index: i,
        label: servers[i].label,
        transport: servers[i].transport,
        host: Model.serverAddressText(servers[i]),
        url: servers[i].url,
        uiUrl: servers[i].uiUrl || servers[i].url,
        ok: configError === "",
        pending: configError === "",
        error: configError,
        errorKind: configError === "" ? "" : "config",
        notice: servers[i].transportNote || "",
        cluster: previous ? previous.cluster : null,
        namespaces: previous ? previous.namespaces.slice() : []
      })
    }

    _draft = draft
    _outstanding = {}
    refreshing = true
    publish()

    for (var j = 0; j < servers.length; j++) {
      if (_draft[j].ok === false) continue // misconfigured, already reported
      if (servers[j].transport === "cli") startCliPoll(generation, j)
      else startHttpPoll(generation, j)
    }
    // A fleet where every server is misconfigured never releases an
    // outstanding request, so the poll has to be able to settle without one.
    settleIfDone()
    watchdog.restart()

    // Whatever level is on screen stays live alongside the poll it belongs to.
    // Forced, because a fetch left in flight from the previous tick would
    // otherwise make this one a no-op. Previous data stays on screen while the
    // new request runs, so re-fetching does not flicker.
    if (activeRoute) fetchDetail(activeRoute, true)
  }

  // --- api key resolution ---------------------------------------------------------

  // Start every apiKeyCommand that has no key yet or whose key has aged out.
  // Returns true if anything was started, in which case the caller stands down
  // and the resolver calls refresh() when the last one lands.
  function resolveKeys(force) {
    var started = false
    for (var i = 0; i < servers.length; i++) {
      if (!keyNeedsResolve(servers[i], force)) continue
      var runner = keyRunners.objectAt(i)
      if (runner && runner.resolve()) started = true
    }
    return started
  }

  function keyNeedsResolve(server, force) {
    if (String(server.apiKeyCommand || "") === "") return false
    var record = _apiKeys[server.index]
    if (!record) return true
    var age = Date.now() - record.at
    // A forced refresh comes from a rejection, and rejections can arrive once
    // per request; the cooldown is what stops that becoming a gpg prompt storm.
    if (force) return age >= keyRetryCooldownMs
    if (server.apiKeyTtlSec <= 0) return false
    return age >= server.apiKeyTtlSec * 1000
  }

  function storeKey(index, value, ok) {
    var keys = {}
    for (var k in _apiKeys) keys[k] = _apiKeys[k]
    // A failed command stores an empty value with a fresh timestamp on purpose:
    // the request that follows fails with an honest "no credential" rather than
    // silently reusing a token that may be why it is failing.
    keys[index] = { value: ok ? value : "", at: Date.now(), failed: !ok || value === "" }
    _apiKeys = keys
  }

  // Re-resolve one server's token after it was rejected, at most once per poll.
  // The resolver restarts the whole poll when it lands, which is the retry.
  function reauthAndRetry(index) {
    var server = servers[index]
    if (!server || String(server.apiKeyCommand || "") === "") return false
    if (_authRetried[index] === _generation) return false
    var runner = keyRunners.objectAt(index)
    if (!runner || !keyNeedsResolve(server, true)) return false

    var retried = {}
    for (var k in _authRetried) retried[k] = _authRetried[k]
    retried[index] = _generation
    _authRetried = retried

    if (!runner.resolve()) return false

    var flags = {}
    for (var f in _reauthed) flags[f] = _reauthed[f]
    flags[index] = true
    _reauthed = flags
    return true
  }

  function clearReauthFlag(index) {
    if (_reauthed[index] !== true) return
    var flags = {}
    for (var k in _reauthed) flags[k] = _reauthed[k]
    delete flags[index]
    _reauthed = flags
  }

  // The context that shapes an error message: which namespace was being read,
  // which call it was, and whether we already tried a fresh token.
  function errorContext(index, extra) {
    var ctx = { refreshed: _reauthed[index] === true }
    for (var key in extra) ctx[key] = extra[key]
    return ctx
  }

  // --- http transport --------------------------------------------------------------

  function startHttpPoll(generation, index) {
    var server = servers[index]

    // Cluster identity is what makes a server read as a server rather than a
    // bag of namespaces. It is cheap and cached until the next poll.
    track(index, 1)
    request(generation, server, Model.clusterUrl(server.url),
      function (json) {
        _draft[index].cluster = Model.parseClusterInfo(json)
        release(generation, index)
      },
      function () {
        // A server can serve workflows while refusing cluster-info; that is not
        // a reason to call the whole server down.
        release(generation, index)
      })

    if (server.namespaces.length > 0) {
      startNamespaces(generation, index, server.namespaces)
      return
    }

    track(index, 1)
    request(generation, server, Model.namespacesUrl(server.url),
      function (json) {
        // Track the namespace fan-out before releasing this request, or the
        // outstanding count dips to zero and the server is declared finished
        // while its real work has not started.
        startNamespaces(generation, index, Model.parseNamespaceList(json))
        release(generation, index)
      },
      function (result) {
        // ListNamespaces is a cluster-level call, so a credential scoped to two
        // namespaces can read both and still be refused it. Failing the server
        // for that hides data the token is entitled to; falling back to the
        // configured list -- or to the one that worked last poll -- does not.
        var fallback = Model.namespaceFallback(server, previousNamespaceNames(index), result)
        if (fallback.fail) {
          failServer(generation, index, fallback.message, result.kind)
          return
        }
        _draft[index].notice = fallback.note
        startNamespaces(generation, index, fallback.names)
        release(generation, index)
      },
      "", { operation: "listNamespaces" })
  }

  // What this server showed last time, which is the second-best answer when the
  // server stops being willing to say.
  function previousNamespaceNames(index) {
    var out = []
    var entries = _draft[index].namespaces
    for (var i = 0; i < entries.length; i++) out.push(entries[i].name)
    return out
  }

  function startNamespaces(generation, index, names) {
    if (generation !== _generation) return

    var entries = []
    for (var i = 0; i < names.length; i++) {
      // Reuse the previous entry for a namespace we already know, so its counts
      // and executions stay on screen until this poll's replace them.
      var carried = null
      var existing = _draft[index].namespaces
      for (var e = 0; e < existing.length; e++) {
        if (existing[e].name === names[i]) carried = existing[e]
      }
      entries.push(carried ? carried : blankNamespace(index, names[i]))
    }
    _draft[index].namespaces = entries

    if (servers[index].transport !== "http") return

    track(index, entries.length * 2)
    for (var j = 0; j < entries.length; j++) {
      fetchCounts(generation, index, j)
      fetchWorkflows(generation, index, j)
    }
  }

  function blankNamespace(serverIndex, name) {
    return {
      kind: "namespace",
      key: Model.namespaceKey(serverIndex, name),
      name: name,
      serverIndex: serverIndex,
      serverLabel: _draft[serverIndex].label,
      uiUrl: _draft[serverIndex].uiUrl,
      counts: {},
      total: 0,
      workflows: [],
      taskQueues: [],
      error: "",
      loading: true
    }
  }

  function fetchCounts(generation, serverIndex, nsIndex) {
    var server = servers[serverIndex]
    var entry = _draft[serverIndex].namespaces[nsIndex]

    request(generation, server, Model.countUrl(server.url, entry.name),
      function (json) {
        var parsed = Model.parseCounts(json)
        entry.counts = parsed.counts
        entry.total = parsed.total
        entry.loading = false
        release(generation, serverIndex)
      },
      function (result) {
        entry.error = result.message
        entry.loading = false
        release(generation, serverIndex)
      },
      "", { namespace: entry.name })
  }

  function fetchWorkflows(generation, serverIndex, nsIndex) {
    var server = servers[serverIndex]
    var entry = _draft[serverIndex].namespaces[nsIndex]
    var state = _draft[serverIndex]

    request(generation, server, Model.workflowsUrl(server.url, entry.name, recentLimit),
      function (json) {
        entry.workflows = Model.parseExecutions(json, {
          index: serverIndex,
          label: state.label,
          uiUrl: state.uiUrl
        }, entry.name)
        entry.taskQueues = Model.taskQueuesFromExecutions(entry.workflows)
        release(generation, serverIndex)
      },
      function (result) {
        entry.error = result.message
        release(generation, serverIndex)
      },
      "", { namespace: entry.name })
  }

  // --- cli transport ----------------------------------------------------------------

  function cliSpec(server, extra) {
    var spec = {
      cli: root.cliPath,
      address: server.address,
      profile: server.profile,
      timeoutSec: Math.max(root.requestTimeoutSec, 10)
    }
    // Credentials come from Model.authSpec so the two transports cannot end up
    // disagreeing about what a server's credentials are. This JSON goes to
    // collect.py on stdin, never as an argument -- see collectorCommand.
    var auth = Model.authSpec(server, apiKeyFor(server))
    for (var field in auth) spec[field] = auth[field]
    for (var key in extra) spec[key] = extra[key]
    return JSON.stringify(spec)
  }

  function startCliPoll(generation, index) {
    var server = servers[index]
    var runner = pollRunners.objectAt(index)
    if (!runner) {
      failServer(generation, index, "cli runner unavailable")
      return
    }
    track(index, 1)
    runner.launch(generation, cliSpec(server, {
      mode: "poll",
      namespaces: server.namespaces,
      // What to show if the server refuses to list namespaces. collect.py does
      // not decide anything with this; it uses it and says that it did.
      fallbackNamespaces: Model.namespaceFallback(server, previousNamespaceNames(index), null).names,
      recentLimit: root.recentLimit
    }))
  }

  function applyCliPoll(generation, index, payload, error) {
    if (generation !== _generation) return
    if (error !== "") {
      var result = Model.classifyError(error, 0, errorContext(index, {}))
      if (result.reauth) reauthAndRetry(index)
      failServer(generation, index, result.message, result.kind)
      return
    }

    var state = _draft[index]
    state.cluster = Model.parseClusterInfo(payload.cluster)

    if (payload.namespaceListError) {
      var listFailure = Model.classifyError(payload.namespaceListError, 0,
        errorContext(index, { operation: "listNamespaces" }))
      if (listFailure.reauth) reauthAndRetry(index)
      state.notice = Model.namespaceFallback(
        servers[index], previousNamespaceNames(index), listFailure).note
    }

    var names = Model.isList(payload.namespaceNames) ? payload.namespaceNames : []
    var entries = []
    for (var i = 0; i < names.length; i++) {
      var entry = blankNamespace(index, names[i])
      var bundle = (payload.results || {})[names[i]] || {}
      var parsed = Model.parseCounts(bundle.count)
      entry.counts = parsed.counts
      entry.total = parsed.total
      entry.workflows = Model.parseExecutions(bundle.list, {
        index: index,
        label: state.label,
        uiUrl: state.uiUrl
      }, names[i])
      entry.taskQueues = Model.taskQueuesFromExecutions(entry.workflows)
      entry.error = String(bundle.error || "")
      entry.loading = false
      entries.push(entry)
    }
    state.namespaces = entries
    release(generation, index)
  }

  // --- outstanding-request bookkeeping ----------------------------------------

  function track(index, count) {
    _outstanding[index] = (_outstanding[index] || 0) + count
  }

  function release(generation, index) {
    if (generation !== _generation) return
    _outstanding[index] = Math.max(0, (_outstanding[index] || 0) - 1)
    if (_outstanding[index] === 0) finishServer(generation, index)
  }

  function finishServer(generation, index) {
    if (generation !== _generation) return
    _draft[index].pending = false
    // A server that answered is a token that works, so the next rejection is a
    // new problem rather than "still rejected".
    if (_draft[index].ok !== false) clearReauthFlag(index)
    publish()
    settleIfDone()
  }

  // A server only fails as a whole when namespace discovery fails; a single bad
  // namespace is recorded on that namespace and the rest still render.
  function failServer(generation, index, message, kind) {
    if (generation !== _generation) return
    _outstanding[index] = 0
    _draft[index].ok = false
    _draft[index].pending = false
    _draft[index].error = message
    _draft[index].errorKind = String(kind || "")
    publish()
    settleIfDone()
  }

  function settleIfDone() {
    for (var i = 0; i < _draft.length; i++) {
      if (_draft[i].pending) return
    }
    refreshing = false
    lastRefreshMs = Date.now()
    watchdog.stop()
  }

  function publish() {
    var out = []
    for (var i = 0; i < _draft.length; i++) {
      var state = _draft[i]
      out.push({
        index: state.index,
        label: state.label,
        transport: state.transport,
        host: state.host,
        url: state.url,
        uiUrl: state.uiUrl,
        ok: state.ok,
        pending: state.pending,
        error: state.error,
        // Why it failed, not just that it did: the panel colours an
        // authentication failure differently from an unreachable host, and
        // `omtemporal doctor` leads with it.
        errorKind: state.errorKind || "",
        notice: state.notice || "",
        cluster: state.cluster,
        namespaces: state.namespaces.slice()
      })
    }
    serverStates = out
  }

  function serverState(index) {
    var states = serverStates
    return index >= 0 && index < states.length ? states[index] : null
  }

  function namespaceState(serverIndex, name) {
    var state = serverState(serverIndex)
    if (!state) return null
    for (var i = 0; i < state.namespaces.length; i++) {
      if (state.namespaces[i].name === name) return state.namespaces[i]
    }
    return null
  }

  // --- detail fetching ------------------------------------------------------------

  function detailFor(route) {
    var key = Model.detailKey(route)
    return key === "" ? null : (details[key] || null)
  }

  function putDetail(key, record) {
    var next = {}
    for (var k in details) next[k] = details[k]
    // A shallow copy, not the working record itself. QML compares `var`
    // properties by reference, so storing the same mutated object leaves
    // `details` looking unchanged and every binding reading it goes stale --
    // the level would sit on "Loading…" until some unrelated property (the
    // relative-time clock) happened to retrigger it.
    var snapshot = {}
    for (var field in record) snapshot[field] = record[field]
    next[key] = snapshot
    details = next
  }

  // `force` distinguishes drilling in (show a spinner) from the background poll
  // refreshing a level already on screen (update in place, no flicker).
  function fetchDetail(route, force) {
    var key = Model.detailKey(route)
    if (key === "" || route.level === "server") return

    var server = servers[route.serverIndex]
    if (!server) return

    var existing = details[key]
    if (existing && existing.loading && !force) return

    _detailGeneration += 1
    var generation = _detailGeneration
    cancelDetailInflight()

    var record = {
      key: key,
      level: route.level,
      loading: true,
      error: "",
      pending: 0,
      workflow: existing ? existing.workflow : null,
      taskQueue: existing ? existing.taskQueue : null,
      schedules: existing ? existing.schedules : [],
      batch: existing ? existing.batch : [],
      namespace: existing ? existing.namespace : null
    }
    putDetail(key, record)

    if (server.transport === "cli") fetchDetailCli(generation, route, key, server, record)
    else fetchDetailHttp(generation, route, key, server, record)
  }

  function finishDetailPart(generation, key, record) {
    if (generation !== _detailGeneration) return
    record.pending = Math.max(0, record.pending - 1)
    if (record.pending === 0) record.loading = false
    putDetail(key, record)
  }

  function fetchDetailHttp(generation, route, key, server, record) {
    function part(url, onOk) {
      record.pending += 1
      request(generation, server, url,
        function (json) {
          if (generation !== _detailGeneration) return
          onOk(json)
          finishDetailPart(generation, key, record)
        },
        function (result) {
          if (generation !== _detailGeneration) return
          record.error = record.error || result.message
          finishDetailPart(generation, key, record)
        },
        "detail", { namespace: route.namespace })
    }

    if (route.level === "workflow") {
      part(Model.describeUrl(server.url, route.namespace, route.workflowId, route.runId),
        function (json) { record.workflow = Model.parseWorkflowDetail(json) })
    } else if (route.level === "taskQueue") {
      // Both sides of the queue: workers poll the workflow side and the
      // activity side separately, and seeing only one of them is how you end up
      // believing a queue has no activity workers when it does.
      record.taskQueue = null
      part(Model.taskQueueUrl(server.url, route.namespace, route.taskQueue, "TASK_QUEUE_TYPE_WORKFLOW"),
        function (json) {
          record.taskQueue = Model.mergeTaskQueue(
            record.taskQueue, Model.parseTaskQueue(json, route.taskQueue, "Workflow"))
        })
      part(Model.taskQueueUrl(server.url, route.namespace, route.taskQueue, "TASK_QUEUE_TYPE_ACTIVITY"),
        function (json) {
          record.taskQueue = Model.mergeTaskQueue(
            record.taskQueue, Model.parseTaskQueue(json, route.taskQueue, "Activity"))
        })
    } else if (route.level === "namespace") {
      part(Model.schedulesUrl(server.url, route.namespace, 20),
        function (json) { record.schedules = Model.parseSchedules(json) })
      part(Model.batchUrl(server.url, route.namespace, 20),
        function (json) { record.batch = Model.parseBatchOperations(json) })
      part(Model.namespaceUrl(server.url, route.namespace),
        function (json) { record.namespace = Model.parseNamespaceDetail(json) })
    }
  }

  function fetchDetailCli(generation, route, key, server, record) {
    var runner = detailRunner
    var mode = route.level === "workflow" ? "workflow"
      : (route.level === "taskQueue" ? "taskqueue" : "namespace")

    record.pending = 1
    putDetail(key, record)

    runner.launch(generation, key, route, cliSpec(server, {
      mode: mode,
      namespace: route.namespace,
      workflowId: route.workflowId || "",
      runId: route.runId || "",
      taskQueue: route.taskQueue || ""
    }))
  }

  function applyCliDetail(generation, key, route, payload, error) {
    if (generation !== _detailGeneration) return
    var record = details[key]
    if (!record) return

    if (error !== "") {
      record.error = error
    } else if (route.level === "workflow") {
      record.workflow = Model.parseWorkflowDetail(payload.detail)
    } else if (route.level === "taskQueue") {
      record.taskQueue = Model.parseTaskQueue(payload.taskQueue, route.taskQueue)
    } else {
      record.schedules = Model.parseSchedules(payload.schedules)
      record.batch = Model.parseBatchOperations(payload.batch)
      record.namespace = payload.namespace ? Model.parseNamespaceDetail(payload.namespace) : null
      if (payload.error) record.error = String(payload.error)
    }

    record.pending = 0
    record.loading = false
    putDetail(key, record)
  }

  // --- http plumbing -------------------------------------------------------------------

  // onError receives a classification from Model.classifyError, not a string:
  // callers that only want to show something read .message, and the ones that
  // have to decide -- fall back to configured namespaces, refresh the token --
  // read .kind.
  function request(generation, server, url, onOk, onError, pool, context) {
    var xhr = new XMLHttpRequest()
    if (pool === "detail") _detailInflight.push(xhr)
    else _inflight.push(xhr)

    var ctx = errorContext(server.index, context)

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      if (xhr.cancelled === true) return

      if (xhr.status < 200 || xhr.status >= 300) {
        var result = Model.classifyError(xhr.responseText, xhr.status, ctx)
        // An expired token is both the most likely cause and the one that
        // fixes itself. The error is still reported, so a credential that is
        // simply the wrong credential shows up rather than looping quietly.
        if (result.reauth) root.reauthAndRetry(server.index)
        onError(result)
        return
      }
      var parsed = null
      try {
        parsed = JSON.parse(xhr.responseText)
      } catch (error) {
        onError(Model.classifyError("unreadable response", xhr.status, ctx))
        return
      }
      onOk(parsed)
    }

    xhr.open("GET", url)
    // Accept, then whatever the deployment needs in front of Temporal (a
    // Cloudflare Access pair, say), then the bearer token.
    var headers = Model.httpHeaders(server, apiKeyFor(server))
    for (var name in headers) xhr.setRequestHeader(name, headers[name])
    xhr.send()
  }

  // QML's XMLHttpRequest has no dependable timeout, so sockets are closed here
  // rather than left to the watchdog's generation check alone.
  function cancelInflight() {
    abortAll(_inflight)
    _inflight = []
  }

  function cancelDetailInflight() {
    abortAll(_detailInflight)
    _detailInflight = []
  }

  function abortAll(pool) {
    for (var i = 0; i < pool.length; i++) {
      var xhr = pool[i]
      xhr.cancelled = true
      try {
        xhr.abort()
      } catch (error) {
        // already finished
      }
    }
  }

  function timeoutPending() {
    var generation = _generation
    var message = "no response in " + requestTimeoutSec + "s"

    for (var i = 0; i < _draft.length; i++) {
      var state = _draft[i]
      if (!state.pending) continue
      state.pending = false
      // Namespaces that answered keep their data; a server that never answered
      // at all is reported as down rather than as an empty fleet.
      if (state.namespaces.length === 0) {
        state.ok = false
        state.error = message
      } else {
        for (var j = 0; j < state.namespaces.length; j++) {
          if (state.namespaces[j].loading) {
            state.namespaces[j].loading = false
            state.namespaces[j].error = message
          }
        }
      }
      _outstanding[i] = 0
    }

    cancelInflight()
    if (generation !== _generation) return
    refreshing = false
    lastRefreshMs = Date.now()
    publish()
  }

  // --- cli processes ----------------------------------------------------------------

  // `bash -lc` for the login PATH -- omarchy-shell does not inherit ~/.local/bin,
  // which is where a hand-installed `temporal` usually lands.
  //
  // The spec arrives on stdin, not as an argument. It carries the api key, and
  // /proc/<pid>/cmdline is world readable: as an argument the token would be
  // legible to every user on the machine for as long as the poll ran, several
  // times a minute, forever. `-` is collect.py's "read the spec from stdin".
  function collectorCommand() {
    return ["bash", "-lc", "exec python3 \"$0\" -", root.collectorPath]
  }

  function readCollectorOutput(text, stderrText, exitCode) {
    var raw = String(text || "").trim()
    if (raw === "") {
      return { payload: null, error: Model.errorMessage(stderrText, exitCode || 1) || "no output from collect.py" }
    }
    var parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { payload: null, error: "unreadable collector output" }
    }
    if (parsed && parsed.ok === false) return { payload: null, error: String(parsed.error || "temporal failed") }
    return { payload: parsed, error: "" }
  }

  // One long-lived process slot per server, reused each poll.
  Instantiator {
    id: pollRunners
    model: root.servers

    delegate: Process {
      id: pollProcess
      required property int index
      property int generation: 0
      property string spec: ""

      function launch(gen, specJson) {
        pollProcess.generation = gen
        pollProcess.spec = specJson
        pollProcess.command = root.collectorCommand()
        // Must be set before the process starts: Quickshell closes the write
        // channel at spawn time when this is false, and it cannot be reopened.
        pollProcess.stdinEnabled = true
        pollProcess.running = true
      }

      onStarted: {
        pollProcess.write(pollProcess.spec)
        // Closing stdin is the EOF collect.py's read() is waiting for. Clearing
        // the copy afterwards keeps the token out of a property someone could
        // print while debugging.
        pollProcess.stdinEnabled = false
        pollProcess.spec = ""
      }

      stdout: StdioCollector { id: pollOut; waitForEnd: true }
      stderr: StdioCollector { id: pollErr; waitForEnd: true }

      onExited: function (exitCode) {
        var result = root.readCollectorOutput(pollOut.text, pollErr.text, exitCode)
        root.applyCliPoll(pollProcess.generation, pollProcess.index, result.payload, result.error)
      }
    }
  }

  // Only one level is ever on screen, so one slot covers every detail fetch.
  Process {
    id: detailRunner
    property int generation: 0
    property string key: ""
    property var route: null
    property string spec: ""

    function launch(gen, detailKey, detailRoute, specJson) {
      detailRunner.generation = gen
      detailRunner.key = detailKey
      detailRunner.route = detailRoute
      detailRunner.spec = specJson
      detailRunner.command = root.collectorCommand()
      detailRunner.stdinEnabled = true
      detailRunner.running = true
    }

    onStarted: {
      detailRunner.write(detailRunner.spec)
      detailRunner.stdinEnabled = false
      detailRunner.spec = ""
    }

    stdout: StdioCollector { id: detailOut; waitForEnd: true }
    stderr: StdioCollector { id: detailErr; waitForEnd: true }

    onExited: function (exitCode) {
      var result = root.readCollectorOutput(detailOut.text, detailErr.text, exitCode)
      root.applyCliDetail(detailRunner.generation, detailRunner.key, detailRunner.route,
        result.payload, result.error)
    }
  }

  // --- api key resolver processes ---------------------------------------------

  // One process slot per server that configures `apiKeyCommand`, so tokens can
  // live in `pass`, `gopass`, `secret-tool` or `op` instead of in shell.json.
  // Started on demand rather than at load: the poll asks for a key when it
  // needs one and when the one it has has aged out.
  Instantiator {
    id: keyRunners
    model: root.servers

    delegate: Process {
      id: keyProcess
      required property var modelData

      readonly property string keyCommand: String(modelData.apiKeyCommand || "")

      command: ["bash", "-lc", keyCommand]

      function resolve() {
        if (keyCommand === "" || keyProcess.running) return false
        root._pendingKeys += 1
        keyProcess.running = true
        return true
      }

      stdout: StdioCollector { id: keyOut; waitForEnd: true }
      // Collected and thrown away. A password manager writes prompts and
      // warnings here, and forwarding them to the panel is how a passphrase
      // prompt ends up rendered as a workflow error.
      stderr: StdioCollector { id: keyErr; waitForEnd: true }

      onExited: function (exitCode) {
        root._pendingKeys = Math.max(0, root._pendingKeys - 1)
        root.storeKey(modelData.index, String(keyOut.text || "").trim(), exitCode === 0)
        // The label and the exit code only. The command's output is the secret
        // and its stderr may quote it back.
        if (exitCode !== 0) {
          console.warn("temporal: apiKeyCommand for", modelData.label, "exited", exitCode)
        }
        if (root._pendingKeys === 0) root.refresh()
      }
    }
  }

  // --- timers ---------------------------------------------------------------------

  Timer {
    id: pollTimer
    interval: root.effectiveInterval * 1000
    repeat: true
    running: root.configured
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: watchdog
    interval: root.requestTimeoutSec * 1000
    repeat: false
    onTriggered: root.timeoutPending()
  }

  // Re-read the fleet whenever the widget's shell.json entry changes, so adding
  // a server from the setup view takes effect on save rather than on restart.
  onServersChanged: {
    _apiKeys = ({})
    _authRetried = ({})
    _reauthed = ({})
    details = ({})
    Qt.callLater(root.refresh)
  }

  // Opening the panel should show current data, not whatever the slow
  // background poll last left behind.
  onPanelOpenChanged: if (panelOpen) refresh()

  // Saving a file under ~/.config/omarchy/plugins/ hot-reloads this component.
  // An XHR still in flight would then call back into a destroyed object, which
  // Qt reports as "attempted to evaluate a function in an invalid context".
  Component.onDestruction: {
    cancelInflight()
    cancelDetailInflight()
  }
}

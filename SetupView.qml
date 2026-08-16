import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Onboarding, and server management afterwards.
//
// Configuring this plugin used to mean hand-editing a JSON array inside
// shell.json, which nobody discovers from a bar widget. This finds what is
// already on the machine -- servers answering on the usual ports, and profiles
// in the user's temporal.toml -- and adds them on one keystroke.
//
// Writes go through `omarchy-shell shell setBarWidget`, the same IPC that
// `omarchy bar set` uses, so the plugin never edits shell.json itself.
Item {
  id: root

  property string pluginId: "io.github.ancelik.omarchy-temporal"
  property string collectorPath: ""
  property string cliPath: "temporal"
  property var servers: []

  // What an edit looks like before the write has come back around. Persisting
  // goes out to the shell, into shell.json, and only reaches `servers` after a
  // config reload -- so without this every edit shows its OLD value for as long
  // as that takes, which reads as "nothing happened" and gets it retyped.
  property var pendingServers: null
  readonly property var shownServers: pendingServers !== null ? pendingServers : servers

  // Ports a dev server is conventionally reachable on. `temporal server
  // start-dev --http-port 7243` is the documented incantation, and the test bed
  // and most local setups follow it.
  // 127.0.0.1 rather than localhost, deliberately. Docker publishes a port on
  // both stacks, `localhost` resolves to ::1 first, and a broken or filtered
  // IPv6 path then costs a full connect timeout per probe -- the Go gRPC client
  // does not fall back to IPv4 the way curl does, so the CLI simply hangs while
  // the HTTP API looks fine. Probing the v4 address avoids the whole trap.
  property var httpPorts: [7243, 7244, 7245]
  property string probeHost: "127.0.0.1"
  property var grpcAddresses: ["127.0.0.1:7233", "127.0.0.1:7234", "127.0.0.1:7235"]

  property bool scanning: false
  property bool cliAvailable: true
  property var httpFound: []
  property var grpcFound: []
  property var profiles: []
  property string status: ""
  property bool adding: false

  // Editing one server's fields, credentials included. -1 is the server list.
  property int editIndex: -1
  property string editField: ""
  property string editLabel: ""
  property string editValue: ""
  property bool editSecret: false

  readonly property var editServer: editIndex >= 0 && editIndex < shownServers.length
    ? shownServers[editIndex] : null

  readonly property var entries: buildEntries()

  signal changed()
  signal addingChanged2()

  function shellQuoteless(command) { return command }

  // --- discovery -------------------------------------------------------------

  function scan() {
    if (scanning) return
    scanning = true
    httpFound = []
    status = ""
    discovery.launch()
    for (var i = 0; i < httpPorts.length; i++) probeHttp(httpPorts[i])
  }

  // Probed straight from QML: an HTTP server needs no CLI to find, and this is
  // the transport most people should end up on.
  function probeHttp(port) {
    var base = "http://" + probeHost + ":" + port
    var xhr = new XMLHttpRequest()
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== XMLHttpRequest.DONE) return

      // A server that refuses the probe is still a server. Treating a 401 or a
      // 403 as "nothing here" is why a protected deployment used to be
      // invisible on the one screen whose job is finding servers.
      if (xhr.status === 401 || xhr.status === 403) {
        addHttpCandidate(port, base, null, true)
        return
      }
      if (xhr.status < 200 || xhr.status >= 300) return

      var info = null
      try {
        info = Model.parseClusterInfo(JSON.parse(xhr.responseText))
      } catch (error) {
        return
      }
      addHttpCandidate(port, base, info, false)
    }
    xhr.open("GET", base + "/api/v1/cluster-info")
    xhr.send()
  }

  function addHttpCandidate(port, base, info, needsAuth) {
    var found = httpFound.slice()
    for (var i = 0; i < found.length; i++) if (found[i].url === base) return
    found.push({
      port: port,
      url: base,
      // The dev server puts its Web UI 990 above its HTTP port (7243 -> 8233).
      // Probed rather than assumed, so a non-standard layout just means no link.
      uiUrl: "",
      version: info ? info.serverVersion : "",
      clusterName: info ? info.clusterName : "",
      needsAuth: needsAuth === true
    })
    found.sort(function (a, b) { return a.port - b.port })
    httpFound = found
    probeUi(base, port + 990)
  }

  function probeUi(base, uiPort) {
    var uiUrl = "http://" + probeHost + ":" + uiPort
    var xhr = new XMLHttpRequest()
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      if (xhr.status < 200 || xhr.status >= 300) return
      var found = httpFound.slice()
      for (var i = 0; i < found.length; i++) {
        if (found[i].url === base) found[i] = Object.assign({}, found[i], { uiUrl: uiUrl })
      }
      httpFound = found
    }
    xhr.open("GET", uiUrl + "/")
    xhr.send()
  }

  Process {
    id: discovery

    property string spec: ""

    // Same stdin handshake the poll uses. Discovery carries no credentials
    // today, but there is no second way to invoke the collector worth keeping
    // alive just for this.
    function launch() {
      spec = JSON.stringify({
        mode: "discover",
        cli: root.cliPath,
        addresses: root.grpcAddresses,
        timeoutSec: 6
      })
      command = ["bash", "-lc", "exec python3 \"$0\" -", root.collectorPath]
      stdinEnabled = true
      running = true
    }

    onStarted: {
      write(spec)
      stdinEnabled = false
      spec = ""
    }

    stdout: StdioCollector { id: discoveryOut; waitForEnd: true }

    onExited: {
      root.scanning = false
      var payload = null
      try {
        payload = JSON.parse(String(discoveryOut.text || "").trim())
      } catch (error) {
        root.status = "Could not run discovery"
        return
      }
      if (!payload) return
      root.cliAvailable = payload.cliAvailable !== false

      var reachable = []
      var candidates = Model.isList(payload.grpc) ? payload.grpc : []
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] && candidates[i].ok) reachable.push(candidates[i])
      }
      root.grpcFound = reachable
      root.profiles = Model.isList(payload.profiles) ? payload.profiles : []
    }
  }

  // --- persistence --------------------------------------------------------------

  // setBarWidget is the sanctioned way for a widget to change its own settings:
  // the shell owns shell.json and writes it back correctly, preserving this
  // widget's position in the bar.
  function persist(list) {
    // Shown immediately; dropped again once the reload brings the real thing
    // back, or reverted if the shell refuses the write.
    pendingServers = list

    // Wrapped in an object on purpose. `setBarWidget` stores a value that is a
    // bare JSON array as null, but preserves the identical array when it is a
    // field of an object. Model.normalizeServers reads both forms, so a
    // hand-written plain array keeps working.
    writer.payload = JSON.stringify({ list: Model.serversToConfig(list) })
    writer.running = true
    root.changed()
  }

  // A Process rather than execDetached, because setBarWidget answers "ok" or an
  // error string and an edit that silently failed to save is worse than one
  // that refused out loud.
  Process {
    id: writer
    property string payload: ""

    command: ["omarchy-shell", "shell", "setBarWidget", root.pluginId, "servers", payload, "{}"]

    stdout: StdioCollector { id: writerOut; waitForEnd: true }

    onExited: function (exitCode) {
      var answer = String(writerOut.text || "").trim()
      if (exitCode === 0 && answer === "ok") return
      root.pendingServers = null
      root.status = "could not save: " + (answer !== "" ? answer : "exit " + exitCode)
    }
  }

  // The reload landed, so the overlay has done its job.
  onServersChanged: pendingServers = null

  function alreadyConfigured(match) {
    for (var i = 0; i < shownServers.length; i++) {
      var server = shownServers[i]
      if (match.url && server.url === match.url) return true
      if (match.address && server.address === match.address) return true
      if (match.profile && server.profile === match.profile) return true
    }
    return false
  }

  function addServer(config, thenEdit) {
    var list = []
    for (var i = 0; i < shownServers.length; i++) list.push(shownServers[i])
    list.push(Model.normalizeServer(config, list.length))
    persist(list)
    status = "Added " + config.label
    // A candidate that answered 401/403 during discovery is going to need
    // credentials immediately, so open the editor rather than leaving a row
    // that just says "token rejected".
    if (thenEdit) openEditor(list.length - 1)
  }

  function removeServer(index) {
    var list = []
    for (var i = 0; i < shownServers.length; i++) if (i !== index) list.push(shownServers[i])
    persist(list)
    status = "Removed"
  }

  function addManual(text) {
    var value = String(text || "").trim()
    if (value === "") return

    // A URL means HTTP; a bare host:port means the CLI. Which is exactly the
    // distinction the transport setting encodes, so it can be inferred here
    // rather than asked about.
    var config = value.match(/^https?:\/\//)
      ? { url: value, transport: "http" }
      : { address: value, transport: "cli" }
    config.label = Model.hostOf(value) || value
    addServer(config)
    adding = false
  }

  // --- command line surface ------------------------------------------------------
  //
  // `omtemporal add|remove|list` calls straight into these, so the terminal and
  // the panel cannot drift apart in how they interpret an address.

  function addFromCli(spec) {
    // Parsed in Model.js so the option grammar is checkable without a shell.
    var parsed = Model.parseAddSpec(spec)
    if (!parsed.ok) return parsed.message

    var config = parsed.config
    if (alreadyConfigured(config)) return "already configured: " + config.label

    // Normalized before the verdict, so mTLS moving the entry onto the cli
    // transport -- or a config that cannot work at all -- is reported now
    // rather than discovered later as an empty panel.
    var normalized = Model.normalizeServer(config, servers.length)
    if (!normalized) return "cannot read that as a server"
    var fatal = Model.hasConfigError(normalized)
    if (fatal !== "") return "not added — " + fatal

    addServer(config)
    return Model.addVerdict(normalized, parsed.warnings)
  }

  // Jump straight to one server's credentials, for `omtemporal edit <label>`
  // and for a keybind that goes where the token needs changing.
  function editByLabel(label) {
    var wanted = String(label || "").trim()
    if (wanted === "") return "usage: edit <label>"
    for (var i = 0; i < shownServers.length; i++) {
      if (shownServers[i].label === wanted) {
        openEditor(i)
        return "editing " + wanted
      }
    }
    return "no server labelled " + wanted
  }

  function removeByLabel(label) {
    var wanted = String(label || "").trim()
    if (wanted === "") return "usage: remove <label>"
    for (var i = 0; i < shownServers.length; i++) {
      if (shownServers[i].label === wanted) {
        removeServer(i)
        return "removed " + wanted
      }
    }
    return "no server labelled " + wanted
  }

  function describeConfigured() {
    if (servers.length === 0) return "no servers configured"
    var lines = []
    for (var i = 0; i < servers.length; i++) {
      lines.push([
        servers[i].label,
        servers[i].transport,
        Model.serverAddressText(servers[i]),
        Model.authSummary(servers[i]).text
      ].join("\t"))
    }
    return lines.join("\n")
  }

  // --- entries ---------------------------------------------------------------------

  function buildEntries() {
    if (editServer) return buildFieldEntries()

    var out = []

    // What is configured now
    if (shownServers.length === 0) {
      out.push(Model.noteEntry("CONFIGURED SERVERS",
        "None yet. Pick one below, or add an address by hand."))
    } else {
      for (var i = 0; i < shownServers.length; i++) {
        var server = shownServers[i]
        var summary = Model.authSummary(server)
        out.push(Model.entry({
          section: "CONFIGURED SERVERS",
          sectionHint: "Enter to edit credentials and addresses. x removes one.",
          kind: "server",
          title: server.label,
          subtitle: Model.serverAddressText(server) + "  ·  " + server.transport
            + (summary.text === "none" ? "" : "  ·  " + summary.text),
          trailing: "edit",
          tone: "dim",
          action: "editServer",
          payload: { index: i }
        }))
        // Anything already known to be wrong with this server's credentials,
        // shown where the server is rather than saved for the first poll.
        var issues = Model.authConfigIssues(server)
        for (var k = 0; k < issues.length; k++) {
          out.push(Model.noteEntry("CONFIGURED SERVERS", issues[k].text,
            issues[k].level === "error" ? "bad" : "dim"))
        }
      }
    }

    // Found by probing
    var found = 0
    var suppressed = 0
    for (var h = 0; h < httpFound.length; h++) {
      var candidate = httpFound[h]
      if (alreadyConfigured({ url: candidate.url })) {
        suppressed += 1
        continue
      }
      found += 1
      out.push(Model.entry({
        section: "FOUND ON THIS MACHINE",
        sectionHint: "Servers answering on this machine. HTTP is the faster transport.",
        kind: "server",
        title: candidate.url,
        subtitle: candidate.needsAuth
          ? "Temporal HTTP API — refused the probe, so it wants credentials"
          : (candidate.clusterName
            ? candidate.clusterName + "  ·  Temporal " + candidate.version
            : "Temporal HTTP API"),
        trailing: candidate.needsAuth ? "http · auth" : "http",
        action: "addHttp",
        payload: candidate
      }))
    }
    for (var g = 0; g < grpcFound.length; g++) {
      var grpc = grpcFound[g]
      if (alreadyConfigured({ address: grpc.address })) {
        suppressed += 1
        continue
      }
      // A gRPC port whose HTTP sibling was already found is the same server
      // twice; offering both would just be confusing.
      var duplicate = false
      for (var d = 0; d < httpFound.length; d++) {
        if (!alreadyConfigured({ url: httpFound[d].url })) duplicate = true
      }
      if (duplicate && found > 0) continue
      out.push(Model.entry({
        section: "FOUND ON THIS MACHINE",
        sectionHint: "Servers answering on this machine.",
        kind: "server",
        title: grpc.address,
        subtitle: grpc.clusterName
          ? grpc.clusterName + "  ·  Temporal " + grpc.version
          : "gRPC, via the temporal CLI",
        trailing: "cli",
        action: "addGrpc",
        payload: grpc
      }))
    }
    if (found === 0) {
      // "Nothing here" and "everything here is already added" are different
      // answers, and only one of them is a problem worth investigating.
      out.push(Model.noteEntry("FOUND ON THIS MACHINE",
        scanning
          ? "Scanning…"
          : (suppressed > 0
            ? "Everything answering locally is already configured."
            : "Nothing answering on the usual local ports.")))
    }

    // CLI profiles
    if (!cliAvailable) {
      out.push(Model.noteEntry("TEMPORAL CLI PROFILES",
        "The temporal CLI is not installed, so saved profiles cannot be read."))
    } else if (profiles.length === 0) {
      out.push(Model.noteEntry("TEMPORAL CLI PROFILES",
        "No profiles in temporal.toml. `temporal config set` creates one."))
    } else {
      for (var p = 0; p < profiles.length; p++) {
        var profile = profiles[p]
        if (alreadyConfigured({ profile: profile.name })) continue
        out.push(Model.entry({
          section: "TEMPORAL CLI PROFILES",
          sectionHint: "From your temporal.toml — credentials and TLS come with them.",
          kind: "server",
          title: profile.name,
          subtitle: profile.address || "address from profile",
          trailing: "cli",
          action: "addProfile",
          payload: profile
        }))
      }
    }

    out.push(Model.entry({
      section: "OTHER",
      kind: "",
      glyph: "󰐕",
      title: adding ? "Type an address, then Enter" : "Add an address by hand",
      subtitle: adding ? "" : "http://host:7243 for HTTP, or host:7233 for the CLI",
      action: "toggleAdd"
    }))
    out.push(Model.entry({
      section: "OTHER",
      kind: "",
      glyph: "󰑐",
      title: "Rescan",
      subtitle: scanning ? "scanning…" : "look again for local servers and profiles",
      action: "rescan"
    }))

    return out
  }

  // --- actions -----------------------------------------------------------------------

  // One entry per editable field. Secrets show their length, never their value:
  // a bar panel is a screen-sharing hazard and the key is already stored.
  function buildFieldEntries() {
    var out = []
    var server = editServer
    var fields = Model.serverFields(server)

    for (var i = 0; i < fields.length; i++) {
      var field = fields[i]
      var shown = field.secret && field.value
        ? "•".repeat(Math.min(12, String(field.value).length))
        : String(field.value || "")
      out.push(Model.entry({
        form: true,
        section: field.group,
        sectionHint: Model.fieldGroupHint(field.group),
        kind: "",
        // No per-field glyphs: a single key icon on one row of a form pulls the
        // eye to whichever field happens to have it rather than to the one you
        // came to change.
        glyph: "",
        title: field.label,
        subtitle: field.hint || "",
        trailing: shown === "" ? "—" : shown,
        tone: shown === "" ? "dim" : "normal",
        action: field.kind === "toggle" ? "toggleField" : "editField",
        payload: { key: field.key, label: field.label, value: field.value, secret: field.secret === true }
      }))
    }

    var issues = Model.authConfigIssues(server)
    for (var k = 0; k < issues.length; k++) {
      out.push(Model.noteEntry("PROBLEMS", issues[k].text,
        issues[k].level === "error" ? "bad" : "dim"))
    }

    out.push(Model.entry({
      section: "THIS SERVER",
      kind: "",
      glyph: "󰄬",
      title: "Done",
      subtitle: "back to the server list",
      action: "backToList"
    }))
    out.push(Model.entry({
      section: "THIS SERVER",
      kind: "",
      glyph: "󰅖",
      title: "Remove this server",
      tone: "bad",
      action: "removeEdited"
    }))
    return out
  }

  function openEditor(index) {
    editIndex = index
    editField = ""
    status = ""
  }

  function closeEditor() {
    editIndex = -1
    editField = ""
  }

  function beginField(payload) {
    editField = String(payload.key)
    editLabel = String(payload.label)
    // A secret starts blank rather than pre-filled: retyping it is safer than
    // editing something the panel just put on screen, and blank means "leave it".
    editValue = payload.secret ? "" : String(payload.value || "")
    editSecret = payload.secret === true
  }

  function commitField(text) {
    var server = editServer
    if (!server) return
    var value = String(text === undefined || text === null ? "" : text)

    // Submitting an untouched secret prompt should not wipe the stored key.
    if (editSecret && value === "") {
      editField = ""
      return
    }

    var updated = Model.applyServerField(server, editField, value)
    var list = []
    for (var i = 0; i < shownServers.length; i++) {
      list.push(i === editIndex ? Model.normalizeServer(updated, i) : shownServers[i])
    }
    persist(list)
    status = editLabel + " updated"
    editField = ""
  }

  function toggleField(payload) {
    var server = editServer
    if (!server) return
    var updated = Model.applyServerField(server, String(payload.key), "")
    var list = []
    for (var i = 0; i < shownServers.length; i++) {
      list.push(i === editIndex ? Model.normalizeServer(updated, i) : shownServers[i])
    }
    persist(list)
    status = String(payload.label) + " changed"
  }

  function activate(entry) {
    if (!entry) return false
    switch (String(entry.action)) {
    case "addHttp":
      addServer({
        label: "local:" + entry.payload.port,
        url: entry.payload.url,
        uiUrl: entry.payload.uiUrl,
        transport: "http"
      }, entry.payload.needsAuth === true)
      return true
    case "addGrpc":
      addServer({
        label: entry.payload.address,
        address: entry.payload.address,
        transport: "cli"
      })
      return true
    case "addProfile":
      addServer({
        label: entry.payload.name,
        profile: entry.payload.name,
        transport: "cli"
      })
      return true
    case "editServer":
      openEditor(entry.payload.index)
      return true
    case "editField":
      beginField(entry.payload)
      return true
    case "toggleField":
      toggleField(entry.payload)
      return true
    case "backToList":
      closeEditor()
      return true
    case "removeEdited":
      var doomed = editIndex
      closeEditor()
      removeServer(doomed)
      return true
    case "removeServer":
      removeServer(entry.payload.index)
      return true
    case "toggleAdd":
      adding = !adding
      return true
    case "rescan":
      scan()
      return true
    }
    return false
  }
}

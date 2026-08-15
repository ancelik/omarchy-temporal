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

  property string pluginId: "com.anilcelik.temporal"
  property string collectorPath: ""
  property string cliPath: "temporal"
  property var servers: []

  // Ports a dev server is conventionally reachable on. `temporal server
  // start-dev --http-port 7243` is the documented incantation, and the test bed
  // and most local setups follow it.
  property var httpPorts: [7243, 7244, 7245]
  property var grpcAddresses: ["localhost:7233", "localhost:7234", "localhost:7235"]

  property bool scanning: false
  property bool cliAvailable: true
  property var httpFound: []
  property var grpcFound: []
  property var profiles: []
  property string status: ""
  property bool adding: false

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
    var base = "http://localhost:" + port
    var xhr = new XMLHttpRequest()
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      if (xhr.status < 200 || xhr.status >= 300) return
      var info = null
      try {
        info = Model.parseClusterInfo(JSON.parse(xhr.responseText))
      } catch (error) {
        return
      }
      addHttpCandidate(port, base, info)
    }
    xhr.open("GET", base + "/api/v1/cluster-info")
    xhr.send()
  }

  function addHttpCandidate(port, base, info) {
    var found = httpFound.slice()
    for (var i = 0; i < found.length; i++) if (found[i].url === base) return
    found.push({
      port: port,
      url: base,
      // The dev server puts its Web UI 990 above its HTTP port (7243 -> 8233).
      // Probed rather than assumed, so a non-standard layout just means no link.
      uiUrl: "",
      version: info ? info.serverVersion : "",
      clusterName: info ? info.clusterName : ""
    })
    found.sort(function (a, b) { return a.port - b.port })
    httpFound = found
    probeUi(base, port + 990)
  }

  function probeUi(base, uiPort) {
    var uiUrl = "http://localhost:" + uiPort
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

    function launch() {
      var spec = JSON.stringify({
        mode: "discover",
        cli: root.cliPath,
        addresses: root.grpcAddresses,
        timeoutSec: 6
      })
      command = ["bash", "-lc", "exec python3 \"$0\" \"$1\"", root.collectorPath, spec]
      running = true
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
    // Wrapped in an object on purpose. `setBarWidget` stores a value that is a
    // bare JSON array as null, but preserves the identical array when it is a
    // field of an object. Model.normalizeServers reads both forms, so a
    // hand-written plain array keeps working.
    var json = JSON.stringify({ list: Model.serversToConfig(list) })
    Quickshell.execDetached([
      "bash", "-lc",
      "exec omarchy-shell shell setBarWidget \"$0\" servers \"$1\" '{}'",
      root.pluginId, json
    ])
    root.changed()
  }

  function alreadyConfigured(match) {
    for (var i = 0; i < servers.length; i++) {
      var server = servers[i]
      if (match.url && server.url === match.url) return true
      if (match.address && server.address === match.address) return true
      if (match.profile && server.profile === match.profile) return true
    }
    return false
  }

  function addServer(config) {
    var list = []
    for (var i = 0; i < servers.length; i++) list.push(servers[i])
    list.push(Model.normalizeServer(config, list.length))
    persist(list)
    status = "Added " + config.label
  }

  function removeServer(index) {
    var list = []
    for (var i = 0; i < servers.length; i++) if (i !== index) list.push(servers[i])
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
    var value = String(spec || "").trim()
    if (value === "") return "usage: add <url|host:port|profile:NAME> [label]"

    var parts = value.split(/\s+/)
    var target = parts[0]
    var label = parts.length > 1 ? parts.slice(1).join(" ") : ""

    var config = null
    if (target.indexOf("profile:") === 0) {
      config = { profile: target.substring(8), transport: "cli" }
      config.label = label || config.profile
    } else if (target.match(/^https?:\/\//)) {
      config = { url: target, transport: "http" }
      config.label = label || Model.hostOf(target)
    } else {
      config = { address: target, transport: "cli" }
      config.label = label || target
    }

    if (alreadyConfigured(config)) return "already configured: " + config.label
    addServer(config)
    return "added " + config.label + " (" + config.transport + ")"
  }

  function removeByLabel(label) {
    var wanted = String(label || "").trim()
    if (wanted === "") return "usage: remove <label>"
    for (var i = 0; i < servers.length; i++) {
      if (servers[i].label === wanted) {
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
      lines.push([servers[i].label, servers[i].transport, Model.serverAddressText(servers[i])].join("\t"))
    }
    return lines.join("\n")
  }

  // --- entries ---------------------------------------------------------------------

  function buildEntries() {
    var out = []

    // What is configured now
    if (servers.length === 0) {
      out.push(Model.noteEntry("CONFIGURED SERVERS",
        "None yet. Pick one below, or add an address by hand."))
    } else {
      for (var i = 0; i < servers.length; i++) {
        var server = servers[i]
        out.push(Model.entry({
          section: "CONFIGURED SERVERS",
          sectionHint: "Enter removes one.",
          kind: "server",
          title: server.label,
          subtitle: Model.serverAddressText(server) + "  ·  " + server.transport,
          trailing: "remove",
          tone: "dim",
          action: "removeServer",
          payload: { index: i }
        }))
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
        subtitle: candidate.clusterName
          ? candidate.clusterName + "  ·  Temporal " + candidate.version
          : "Temporal HTTP API",
        trailing: "http",
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

  function activate(entry) {
    if (!entry) return false
    switch (String(entry.action)) {
    case "addHttp":
      addServer({
        label: "local:" + entry.payload.port,
        url: entry.payload.url,
        uiUrl: entry.payload.uiUrl,
        transport: "http"
      })
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

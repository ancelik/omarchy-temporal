import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar widget and drill-down panel for Temporal.
//
// The panel is a stack of levels -- servers, one server, one namespace, one
// workflow, one task queue -- and each level shows exactly one kind of thing.
// That is deliberate: mixing servers and workflows in a single scroll is what
// made the earlier version unable to teach what any of them were.
//
// This file is the router. It owns the route, the cursor and the keys; what
// each level actually contains is decided by the entry builders in Model.js and
// drawn by EntryList.
Panel {
  id: root
  moduleName: "com.anilcelik.temporal"
  ipcTarget: "temporal"
  manageIpc: false

  // --- navigation state ------------------------------------------------------

  property var route: Model.routeFleet()
  property int cursorIndex: 0
  property bool cursorActive: false
  property string filter: "all"

  // Ages are relative, so they need a clock. Only ticks while the panel is
  // open -- a bar widget has no business waking the shell once a second.
  property double nowMs: Date.now()

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // qs.Ui.Panel does not carry the bar geometry that qs.Ui.BarWidget does, so
  // a panel-rooted widget has to lift `vertical` off the host itself.
  readonly property bool vertical: bar ? bar.vertical : false

  readonly property var totals: service.totals
  readonly property bool allDown: totals.servers > 0 && totals.down === totals.servers
  readonly property bool hideWhenIdle: setting("hideWhenIdle", false) === true

  // Onboarding takes over whenever there is nothing configured, so a fresh
  // install opens on something actionable rather than an empty list.
  readonly property bool onboarding: !service.configured || route.level === "setup"

  // Bound to service.details rather than fetched, so a late reply repaints the
  // level that asked for it.
  readonly property var detail: {
    var all = service.details
    var key = Model.detailKey(route)
    return key === "" ? null : (all[key] || null)
  }

  readonly property var entries: {
    if (onboarding) return setup.entries
    switch (route.level) {
    case "fleet":
      return Model.fleetEntries(service.serverStates, nowMs)
    case "server":
      return Model.serverEntries(service.serverState(route.serverIndex), nowMs)
    case "namespace":
      return Model.namespaceEntries(
        service.namespaceState(route.serverIndex, route.namespace), detail, filter, nowMs)
    case "workflow":
      return Model.workflowDetailEntries(detail, route, nowMs)
    case "taskQueue":
      return Model.taskQueueEntries(detail, nowMs)
    }
    return []
  }

  readonly property var crumbs: Model.breadcrumb(route, service.serverStates)

  // The line under the breadcrumb answers "what am I looking at" for whichever
  // level is on screen, rather than always reporting the fleet.
  readonly property string contextLine: {
    if (onboarding) return service.configured ? "Manage servers" : "Let's find a Temporal server"
    switch (route.level) {
    case "fleet":
      return Model.summaryText(totals, service.refreshing)
    case "server": {
      var server = service.serverState(route.serverIndex)
      if (!server) return ""
      if (server.ok === false) return String(server.error || "unreachable")
      return Model.summaryText(Model.serverTotals(server), service.refreshing)
    }
    case "namespace": {
      var namespace = service.namespaceState(route.serverIndex, route.namespace)
      if (!namespace) return ""
      var counts = Model.namespaceTotals(namespace)
      var text = counts.running + " running"
      if (counts.failed > 0) text += " · " + counts.failed + " failed"
      if (filter !== "all") text += " · showing " + Model.FILTER_LABEL[filter].toLowerCase()
      return text
    }
    case "workflow":
      return detail && detail.workflow
        ? Model.statusLabel(detail.workflow.status) + " · " + detail.workflow.activities.length + " pending activities"
        : "Loading…"
    case "taskQueue":
      return detail && detail.taskQueue
        ? Model.plural(detail.taskQueue.pollers.length, "worker") + " polling"
        : "Loading…"
    }
    return ""
  }

  // --- bar button --------------------------------------------------------------

  // The bar reports failures from the fetched window, not the namespace lifetime
  // totals the panel shows. A namespace that failed something last Tuesday
  // would otherwise pin the widget to urgent forever, which trains you to
  // ignore it -- exactly backwards.
  readonly property bool troubled: totals.recentFailed > 0 || allDown

  readonly property string barTooltip: {
    if (!service.configured) return "Temporal: click to set up a server"
    if (allDown) return "Temporal: " + (totals.servers === 1 ? "server unreachable" : "all servers unreachable")
    var text = "Temporal · " + Model.summaryText(totals, service.refreshing)
    // The bar count and the panel count deliberately differ; say so here rather
    // than let someone discover it as an inconsistency.
    if (totals.recentFailed > 0) text += " · " + totals.recentFailed + " recent failures"
    return text
  }

  visible: !hideWhenIdle || !service.configured || totals.running > 0 || totals.failed > 0 || totals.down > 0
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // --- navigation --------------------------------------------------------------

  function go(next) {
    if (!next) return
    // Entering setup any other way than a cold start still needs a scan, or the
    // discovery sections sit there claiming nothing is out here.
    if (next.level === "setup" && route.level !== "setup") setup.scan()
    route = next
    cursorActive = false
    cursorIndex = Math.max(0, Model.firstSelectable(entries))
    if (panelFlick) panelFlick.contentY = 0
    service.activeRoute = next
    service.fetchDetail(next, true)
  }

  function ascend() {
    var parent = Model.parentRoute(route)
    if (parent === null) {
      root.close()
      return
    }
    go(parent)
  }

  function activateEntry(entry) {
    if (!entry) return

    if (onboarding) {
      if (setup.activate(entry)) {
        // Adding or removing rewrites shell.json; the cursor should not sit on
        // a row that no longer exists.
        Qt.callLater(function () { cursorIndex = Math.max(0, Model.firstSelectable(entries)) })
      }
      return
    }

    var payload = entry.payload || {}
    switch (String(entry.action)) {
    case "openServer":
      go(Model.routeServer(payload.serverIndex))
      break
    case "openNamespace":
      go(Model.routeNamespace(payload.serverIndex, payload.namespace))
      break
    case "openTaskQueue":
      go(Model.routeTaskQueue(payload.serverIndex, payload.namespace, payload.taskQueue))
      break
    case "openWorkflow":
      go(Model.routeWorkflow(payload.serverIndex, payload.namespace, payload.workflowId, payload.runId))
      break
    case "openInBrowser":
      openCurrentInBrowser()
      break
    case "openSetup":
      go(Model.routeSetup())
      break
    case "retry":
      service.refresh()
      break
    }
  }

  function moveCursor(delta) {
    cursorActive = true
    var next = Model.nextSelectable(entries, cursorIndex, delta)
    if (next >= 0) cursorIndex = next
    scrollCursorIntoView()
  }

  function selectedEntry() {
    if (cursorIndex < 0 || cursorIndex >= entries.length) return null
    return entries[cursorIndex]
  }

  // --- actions -------------------------------------------------------------------

  // `o` always means "show me this in the Web UI", whatever level you are on.
  function openCurrentInBrowser() {
    var server = service.serverState(route.serverIndex)
    var uiUrl = server ? server.uiUrl : ""

    if (route.level === "workflow") {
      var url = Model.workflowUiUrl(uiUrl, route.namespace, route.workflowId, route.runId)
      if (url !== "") openUrl(url)
      return
    }
    if (route.level === "namespace" || route.level === "taskQueue") {
      var nsUrl = Model.namespaceUiUrl(uiUrl, route.namespace)
      if (nsUrl !== "") openUrl(nsUrl)
      return
    }
    if (uiUrl !== "") {
      openUrl(uiUrl)
      return
    }
    // At fleet level with no server selected, fall back to the first one that
    // has a Web UI configured.
    var states = service.serverStates
    for (var i = 0; i < states.length; i++) {
      if (states[i].uiUrl) {
        openUrl(states[i].uiUrl)
        return
      }
    }
  }

  function openUrl(url) {
    Qt.openUrlExternally(url)
    root.close()
  }

  function cycleFilter() {
    filter = Model.nextFilter(filter)
    cursorIndex = Math.max(0, Model.firstSelectable(entries))
  }

  function scrollItemIntoView(item) {
    if (!panelFlick || !item) return
    Qt.callLater(function () {
      if (!item) return
      var margin = Style.space(6)
      var point = item.mapToItem(panelFlick.contentItem, 0, 0)
      var top = point.y
      var bottom = top + item.height
      var viewTop = panelFlick.contentY
      var viewBottom = viewTop + panelFlick.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < viewTop + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewBottom - margin) panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  function scrollCursorIntoView() {
    if (cursorIndex >= 0 && cursorIndex < entryList.children.length) {
      scrollItemIntoView(entryList.children[cursorIndex])
    }
  }

  onOpenedChanged: if (opened) {
    nowMs = Date.now()
    cursorActive = false
    if (panelFlick) panelFlick.contentY = 0
    if (!service.configured) {
      route = Model.routeSetup()
      setup.scan()
    }
    service.activeRoute = route
    service.fetchDetail(route, true)
    cursorIndex = Math.max(0, Model.firstSelectable(entries))
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  Service {
    id: service
    settings: root.settings
    panelOpen: root.opened
  }

  SetupView {
    id: setup
    pluginId: root.moduleName
    collectorPath: service.collectorPath
    cliPath: service.cliPath
    servers: service.servers
    onChanged: Qt.callLater(service.refresh)
  }

  Timer {
    id: clock
    interval: 5000
    repeat: true
    running: root.opened
    onTriggered: root.nowMs = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { service.refresh(); return "ok" }
    function status(): string { return Model.summaryText(root.totals, service.refreshing) }
    function setup(): string { root.go(Model.routeSetup()); root.open(); return "ok" }

    // Jump straight to a level. Handy for a keybind that opens the namespace
    // you actually care about, and the only way to drive the drill-down from a
    // script:
    //
    //   omarchy-shell temporal openAt '{"level":"namespace","serverIndex":0,"namespace":"orders"}'
    function openAt(routeJson: string): string {
      var next = null
      try {
        next = JSON.parse(routeJson)
      } catch (error) {
        return "invalid route: " + error
      }
      if (!next || !next.level) return "route needs a level"
      root.open()
      root.go(next)
      return "ok"
    }

    // Server management, shared with `omtemporal` on the command line. Both go
    // through the same SetupView functions the panel's own keys use, so there
    // is exactly one implementation of adding and removing a server.
    function add(spec: string): string { return setup.addFromCli(spec) }
    function remove(label: string): string { return setup.removeByLabel(label) }
    function listServers(): string { return setup.describeConfigured() }
    function discover(): string { setup.scan(); return "scanning" }

    // Troubleshooting surface: what the widget believes it is talking to, and
    // how each server answered. Cheaper than adding print statements every time
    // a `servers` entry does not behave the way its author expected.
    function servers(): string {
      var states = service.serverStates
      if (states.length === 0) return "no servers configured"
      var lines = []
      for (var i = 0; i < states.length; i++) {
        var state = states[i]
        lines.push([
          state.label,
          state.transport,
          state.host,
          state.pending
            ? "pending"
            : (state.ok ? "ok" : (state.errorKind || "down") + ": " + state.error),
          state.namespaces.length + " namespaces"
            + (state.notice ? " (" + state.notice + ")" : "")
        ].join("  ·  "))
      }
      return lines.join("\n")
    }

    // Why a server might be refusing to answer, in tab-separated fields for
    // `omtemporal doctor` to lay out. Config and last-poll evidence together:
    // "an api key from a command, and the server rejected it" is the sentence
    // that ends the investigation, and neither half says it alone.
    function auth(): string {
      return Model.authReport(service.servers, service.serverStates)
    }
  }

  // Built from parts rather than from WidgetButton's own label because the two
  // numbers mean different things: a healthy running count should stay calm
  // even while the failure count next to it is shouting.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    fixedWidth: root.vertical ? -1 : Math.round(barContent.implicitWidth + Style.space(14))
    tooltipText: root.barTooltip

    onPressed: function (buttonCode) {
      if (buttonCode === Qt.RightButton) service.refresh()
      else if (buttonCode === Qt.MiddleButton) root.openCurrentInBrowser()
      else root.toggle()
    }

    Row {
      id: barContent
      anchors.centerIn: parent
      spacing: Style.space(5)

      TemporalIcon {
        anchors.verticalCenter: parent.verticalCenter
        iconSize: Style.bar.iconFont
        color: root.allDown || !service.configured ? root.urgent : button.foreground
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && !root.allDown && service.configured
        text: root.totals.running
        color: button.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.bar.iconFont
        renderType: Text.NativeRendering
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && !root.allDown && root.totals.recentFailed > 0
        text: Model.statusGlyph("Failed") + " " + root.totals.recentFailed
        color: root.urgent
        font.family: root.fontFamily
        font.pixelSize: Style.bar.iconFont
        renderType: Text.NativeRendering
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(470))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // While the add-a-server field is up it owns the keyboard, or typing an
      // address would drive the cursor instead.
      blocked: addField.visible && addField.activeFocus

      onMoveRequested: function (dx, dy) {
        if (dx < 0) {
          root.ascend()
          return
        }
        if (dx > 0) {
          root.activateEntry(root.selectedEntry())
          return
        }
        if (!root.cursorActive) {
          root.cursorActive = true
          return
        }
        root.moveCursor(dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateEntry(root.selectedEntry())
      onCloseRequested: root.ascend()
      onTabRequested: function (direction) { root.switchPanel(direction) }
      onTextKey: function (text) {
        if (text === "r" || text === "R") {
          if (root.onboarding) setup.scan()
          else {
            service.refresh()
            service.fetchDetail(root.route, true)
          }
        } else if (text === "f" || text === "F") root.cycleFilter()
        else if (text === "o" || text === "O") root.openCurrentInBrowser()
        else if (text === "s" || text === "S") root.go(Model.routeSetup())
        else if (text === "a" || text === "A") {
          if (root.onboarding) {
            setup.adding = true
            Qt.callLater(function () { addField.forceActiveFocus() })
          }
        }
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(10)

          // --- header: mark, breadcrumb, context -------------------------------

          Item {
            width: parent.width
            implicitHeight: Math.max(mark.implicitHeight, headerText.implicitHeight)

            TemporalIcon {
              id: mark
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              iconSize: Style.font.display
              color: root.troubled ? root.urgent : root.foreground
            }

            Column {
              id: headerText
              anchors.left: mark.right
              anchors.leftMargin: Style.space(12)
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              // The breadcrumb is the main teaching device: it names the kind of
              // thing at every level, with that primitive's own glyph.
              Flow {
                id: crumbRow
                width: parent.width
                spacing: Style.space(4)

                Repeater {
                  model: root.crumbs

                  Row {
                    required property var modelData
                    required property int index

                    readonly property bool last: index === root.crumbs.length - 1
                    spacing: Style.space(4)

                    Text {
                      visible: index > 0
                      text: "󰅂"
                      color: Qt.darker(root.foreground, 2.2)
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      anchors.verticalCenter: parent.verticalCenter
                    }

                    Text {
                      text: modelData.glyph
                      color: parent.last ? root.foreground : root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      anchors.verticalCenter: parent.verticalCenter
                    }

                    Text {
                      text: modelData.label
                      color: parent.last ? root.foreground : root.dim
                      font.family: root.fontFamily
                      font.pixelSize: parent.last ? Style.font.title : Style.font.bodySmall
                      font.bold: parent.last
                      anchors.verticalCenter: parent.verticalCenter

                      MouseArea {
                        anchors.fill: parent
                        enabled: !parent.parent.last
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                          // Clicking a crumb jumps straight to that level.
                          var target = root.route
                          for (var i = root.crumbs.length - 1; i > parent.parent.index; i--) {
                            target = Model.parentRoute(target) || target
                          }
                          root.go(target)
                        }
                      }
                    }
                  }
                }
              }

              Text {
                width: parent.width
                text: root.contextLine.toUpperCase()
                visible: text !== ""
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.2
                elide: Text.ElideRight
              }
            }
          }

          PanelSeparator { foreground: root.foreground }

          // --- the level itself -------------------------------------------------

          EntryList {
            id: entryList
            width: parent.width
            entries: root.entries
            cursorIndex: root.cursorIndex
            cursorActive: root.cursorActive
            foreground: root.foreground
            urgent: root.urgent
            dim: root.dim
            fontFamily: root.fontFamily
            onActivated: function (entry) { root.activateEntry(entry) }
            onHovered: function (index) {
              root.cursorActive = true
              root.cursorIndex = index
            }
          }

          TextField {
            id: addField
            visible: root.onboarding && setup.adding
            width: parent.width
            placeholderText: "http://host:7243  or  host:7233"
            foreground: root.foreground
            onAccepted: {
              setup.addManual(text)
              text = ""
              keyCatcher.forceActiveFocus()
            }
            onVisibleChanged: if (visible) Qt.callLater(function () { addField.forceActiveFocus() })
          }

          Text {
            visible: setup.status !== "" && root.onboarding
            width: parent.width
            text: setup.status
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          PanelSeparator { foreground: root.foreground }

          Text {
            width: parent.width
            text: root.onboarding
              ? "enter select · a add by hand · r rescan · esc back"
              : "j/k move · enter open · h back · f filter · r refresh · o web ui · s servers"
            color: root.dim
            opacity: 0.75
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }
        }
      }
    }
  }
}

import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui

// One row, whatever it is showing.
//
// Every primitive in the panel -- a server, a namespace, an activity, a poller
// -- is drawn by this component from the same four slots: a leading glyph, a
// two-line label, and a two-line trailing state. That is what makes the kinds
// comparable at a glance: they differ in glyph and wording, never in layout.
CursorSurface {
  id: root

  property var entry: null
  property bool selected: false

  property color urgent: Color.urgent
  property color dim: Qt.darker(foreground, 1.55)
  property string fontFamily: Style.font.family

  readonly property string tone: entry ? String(entry.tone || "normal") : "normal"
  readonly property bool selectable: entry ? entry.selectable !== false : false
  readonly property bool navigates: entry ? entry.navigates === true : false
  readonly property bool external: entry ? entry.external === true : false
  // A note is commentary on its section -- "nothing found here" -- so it lines
  // up with the section's own text instead of pretending to be a row.
  readonly property bool note: entry ? entry.note === true : false
  // Form rows give up the glyph column too, and their hints wrap: eliding
  // "a command that prints the token" down to "a command that pr…" turns help
  // into noise.
  readonly property bool form: entry ? entry.form === true : false

  // The tone decides the accent colour for the glyph and the trailing state;
  // titles stay in the foreground so a dim row is still readable.
  readonly property color toneColor: tone === "bad" ? urgent : (tone === "dim" ? dim : foreground)

  signal activated()
  signal hovered()

  hasCursor: selected
  implicitHeight: content.implicitHeight + Style.spacing.rowPaddingX

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: root.selectable ? Qt.PointingHandCursor : Qt.ArrowCursor
    acceptedButtons: Qt.LeftButton
    onEntered: if (root.selectable) root.hovered()
    onClicked: if (root.selectable) root.activated()
  }

  RowLayout {
    id: content
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(10)
    anchors.rightMargin: Style.space(10)
    spacing: Style.space(9)

    // Info rows carry no glyph, but they still reserve the column so their
    // labels line up with the rows they describe. Notes give the column up.
    Item {
      visible: !root.note && !root.form
      Layout.alignment: Qt.AlignVCenter
      implicitWidth: Style.font.icon
      implicitHeight: Style.font.icon

      Text {
        anchors.centerIn: parent
        visible: root.entry && String(root.entry.glyph || "") !== ""
        text: root.entry ? String(root.entry.glyph || "") : ""
        color: root.toneColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
      }
    }

    ColumnLayout {
      Layout.fillWidth: true
      spacing: Style.space(1)

      Text {
        Layout.fillWidth: true
        text: root.entry ? String(root.entry.title || "") : ""
        color: root.selectable ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: root.note ? Text.ElideNone : Text.ElideRight
        wrapMode: root.note ? Text.WordWrap : Text.NoWrap
      }

      Text {
        Layout.fillWidth: true
        visible: text !== ""
        text: root.entry ? String(root.entry.subtitle || "") : ""
        // A failure message in the subtitle is the point of the row, so it is
        // allowed to shout even though subtitles are normally quiet.
        color: root.tone === "bad" ? root.urgent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: root.form ? Text.ElideNone : Text.ElideMiddle
        wrapMode: root.form ? Text.WordWrap : Text.NoWrap
      }
    }

    ColumnLayout {
      Layout.alignment: Qt.AlignVCenter
      spacing: Style.space(1)

      Text {
        Layout.alignment: Qt.AlignRight
        visible: text !== ""
        text: root.entry ? String(root.entry.trailing || "") : ""
        color: root.toneColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      Text {
        Layout.alignment: Qt.AlignRight
        visible: text !== ""
        text: root.entry ? String(root.entry.trailingSub || "") : ""
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    // A chevron marks the rows that go somewhere, so the hierarchy is visible
    // before you try it; an arrow marks the ones that leave for the browser.
    //
    // The column is always reserved, even when empty. Hiding it outright let
    // rows without a chevron run further right than rows with one, so the
    // trailing state -- the column you actually read down -- did not line up.
    Item {
      Layout.alignment: Qt.AlignVCenter
      implicitWidth: Style.font.caption
      implicitHeight: Style.font.caption

      Text {
        anchors.centerIn: parent
        visible: root.navigates || root.external
        text: root.external ? "󰏌" : "󰅂"
        color: root.selected ? root.foreground : Qt.darker(root.foreground, 2.2)
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }
}

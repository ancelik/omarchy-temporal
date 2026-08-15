import QtQuick
import qs.Commons
import qs.Ui

// Renders an entry list, emitting a section header wherever the section
// changes.
//
// Every level of the panel is drawn by this one component. Levels differ only
// in the entries Model.js builds for them, which is what stops "a namespace" or
// "an activity" from being rendered two subtly different ways in two places.
Column {
  id: root

  property var entries: []
  property int cursorIndex: -1
  property bool cursorActive: false

  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property color dim: Qt.darker(foreground, 1.55)
  property string fontFamily: Style.font.family

  signal activated(var entry)
  signal hovered(int index)

  spacing: Style.space(2)

  Repeater {
    model: root.entries

    Column {
      id: group

      required property var modelData
      required property int index

      readonly property string section: String(modelData.section || "")
      readonly property var previous: index > 0 ? root.entries[index - 1] : null
      // The first row of a run of same-section entries carries the header for
      // the whole run.
      readonly property bool opensSection: section !== ""
        && (previous === null || String(previous.section || "") !== section)

      width: root.width
      spacing: Style.space(4)
      topPadding: opensSection && index > 0 ? Style.space(10) : 0

      PanelSectionHeader {
        visible: group.opensSection
        text: group.section
        foreground: root.foreground
        fontFamily: root.fontFamily
      }

      // The explainer only appears on the first section of its kind. It is what
      // turns a list of rows into an answer to "what even is this".
      Text {
        visible: group.opensSection && String(group.modelData.sectionHint || "") !== ""
        width: group.width
        text: String(group.modelData.sectionHint || "")
        color: Qt.darker(root.foreground, 2.0)
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
        bottomPadding: Style.space(2)
      }

      PrimitiveRow {
        width: group.width
        entry: group.modelData
        selected: root.cursorActive && root.cursorIndex === group.index
        foreground: root.foreground
        urgent: root.urgent
        dim: root.dim
        fontFamily: root.fontFamily
        onActivated: root.activated(group.modelData)
        onHovered: root.hovered(group.index)
      }
    }
  }
}

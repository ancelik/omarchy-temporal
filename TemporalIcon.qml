import QtQuick
import qs.Commons

// Orbit mark: a ring with a body riding it and a pip at the centre.
//
// Drawn on a Canvas rather than shipped as an SVG for the same reason the
// Tailscale widget draws its own mark — small SVGs render unevenly at bar
// sizes. Stroke weights are fractions of `iconSize` so it stays balanced from
// 12px in the bar up to display size in the panel hero.
//
// This is a generic time/orbit glyph, deliberately not the Temporal logo.
Item {
  id: root

  property real iconSize: Style.space(14)
  property color color: Color.foreground

  implicitWidth: iconSize
  implicitHeight: iconSize

  onColorChanged: canvas.requestPaint()
  onIconSizeChanged: canvas.requestPaint()

  Canvas {
    id: canvas
    anchors.fill: parent

    onPaint: {
      var ctx = getContext("2d")
      var size = Math.min(width, height)
      if (size <= 0) return

      ctx.reset()
      ctx.clearRect(0, 0, width, height)

      var cx = width / 2
      var cy = height / 2
      var stroke = Math.max(1, size * 0.1)
      var body = Math.max(1, size * 0.15)
      // Keep the ring and the body fully inside the box: the body straddles
      // the ring, so it is the outermost thing drawn.
      var radius = size / 2 - Math.max(stroke / 2, body)

      ctx.strokeStyle = root.color
      ctx.fillStyle = root.color
      ctx.lineWidth = stroke
      ctx.lineCap = "round"

      // The ring is broken where the body sits, so the body reads as riding
      // the orbit rather than as a blob stuck on top of a closed circle.
      var bodyAngle = -Math.PI / 4
      var gap = 0.45

      ctx.beginPath()
      ctx.arc(cx, cy, radius, bodyAngle + gap, bodyAngle - gap + 2 * Math.PI)
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(cx + radius * Math.cos(bodyAngle), cy + radius * Math.sin(bodyAngle), body, 0, 2 * Math.PI)
      ctx.fill()

      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(1, size * 0.1), 0, 2 * Math.PI)
      ctx.fill()
    }
  }
}

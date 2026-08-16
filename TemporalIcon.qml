import QtQuick
import qs.Commons

// The Temporal mark.
//
// This is the official symbol's own outline, not an approximation: the path
// from Temporal's `Temporal_Symbol` SVG, converted to absolute cubic beziers
// and normalised into a 0..1 box (the mark occupies 386 of the 1200-unit
// viewBox). Reproducing the real path matters because the mark is not quite
// the two clean crossed ellipses it looks like -- the outlines merge at the
// lower-right crossing, and that asymmetry is present in Temporal's own PNG
// export too, so it is the mark rather than an artefact.
//
// Drawn natively rather than shipped as an SVG for the same reason the
// first-party Tailscale widget draws its own mark: small SVGs render unevenly
// at bar sizes, and a Canvas can take the theme's colour.
//
// Temporal is a trademark of Temporal Technologies. The mark is reproduced here
// to identify the product this widget monitors; the plugin is unofficial and
// not affiliated with or endorsed by Temporal.
Item {
  id: root

  property real iconSize: Style.space(14)
  property color color: Color.foreground

  implicitWidth: iconSize
  implicitHeight: iconSize

  onColorChanged: canvas.requestPaint()
  onIconSizeChanged: canvas.requestPaint()

  // Each entry is either a 2-number move-to, a 6-number cubic, or null to close
  // the current subpath. Holes rely on the original winding order, so the point
  // order below must not be "tidied".
  readonly property var markPath: [
    [0.67526, 0.32474],
    [0.65163, 0.14775, 0.59184, 0.00000, 0.50000, 0.00000],
    [0.40816, 0.00000, 0.34837, 0.14775, 0.32474, 0.32474],
    [0.14775, 0.34837, 0.00000, 0.40816, 0.00000, 0.50000],
    [0.00000, 0.59184, 0.14777, 0.65163, 0.32474, 0.67526],
    [0.34837, 0.85223, 0.40816, 1.00000, 0.50000, 1.00000],
    [0.59184, 1.00000, 0.65163, 0.85223, 0.67526, 0.67526],
    [0.85225, 0.65163, 1.00000, 0.59184, 1.00000, 0.50000],
    [1.00000, 0.40816, 0.85223, 0.34837, 0.67526, 0.32474],
    null,
    [0.31896, 0.62370],
    [0.14946, 0.59922, 0.05060, 0.54319, 0.05060, 0.50000],
    [0.05060, 0.45681, 0.14946, 0.40078, 0.31896, 0.37630],
    [0.31523, 0.41710, 0.31329, 0.45876, 0.31329, 0.50000],
    [0.31329, 0.54124, 0.31523, 0.58293, 0.31896, 0.62370],
    null,
    [0.50000, 0.05060],
    [0.54319, 0.05060, 0.59922, 0.14946, 0.62370, 0.31896],
    [0.58293, 0.31523, 0.54124, 0.31329, 0.50000, 0.31329],
    [0.45876, 0.31329, 0.41707, 0.31523, 0.37630, 0.31896],
    [0.40078, 0.14946, 0.45681, 0.05060, 0.50000, 0.05060],
    null,
    [0.68104, 0.62370],
    [0.67269, 0.62492, 0.63847, 0.62894, 0.62982, 0.62979],
    [0.62896, 0.63847, 0.62492, 0.67267, 0.62373, 0.68101],
    [0.59925, 0.85052, 0.54321, 0.94938, 0.50003, 0.94938],
    [0.45684, 0.94938, 0.40080, 0.85052, 0.37632, 0.68101],
    [0.37513, 0.67267, 0.37109, 0.63845, 0.37023, 0.62979],
    [0.36630, 0.58961, 0.36391, 0.54645, 0.36391, 0.50000],
    [0.36391, 0.45355, 0.36630, 0.41039, 0.37023, 0.37018],
    [0.41041, 0.36624, 0.45358, 0.36386, 0.50003, 0.36386],
    [0.54648, 0.36386, 0.58964, 0.36624, 0.62982, 0.37018],
    [0.63850, 0.37104, 0.67269, 0.37508, 0.68104, 0.37627],
    [0.85054, 0.40075, 0.94943, 0.45681, 0.94943, 0.49997],
    [0.94943, 0.54313, 0.85054, 0.59922, 0.68104, 0.62370],
    null
  ]

  Canvas {
    id: canvas
    anchors.fill: parent

    onPaint: {
      var ctx = getContext("2d")
      var size = Math.min(width, height)
      if (size <= 0) return

      ctx.reset()
      ctx.clearRect(0, 0, width, height)

      // Centre the square mark inside whatever box we were given.
      var ox = (width - size) / 2
      var oy = (height - size) / 2

      ctx.fillStyle = root.color
      ctx.beginPath()

      var segments = root.markPath
      for (var i = 0; i < segments.length; i++) {
        var s = segments[i]
        if (s === null) {
          ctx.closePath()
        } else if (s.length === 2) {
          ctx.moveTo(ox + s[0] * size, oy + s[1] * size)
        } else {
          ctx.bezierCurveTo(
            ox + s[0] * size, oy + s[1] * size,
            ox + s[2] * size, oy + s[3] * size,
            ox + s[4] * size, oy + s[5] * size)
        }
      }

      ctx.fill()
    }
  }
}

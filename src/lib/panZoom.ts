// Pan / zoom maths for a canvas shown through a viewport: the canvas is drawn
// at `translate(x, y) scale(k)`. Pure functions, so gestures stay in the
// component and the arithmetic stays testable.

export interface View {
  x: number
  y: number
  k: number
}

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2.5

export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))

/** Zooms by `factor` keeping the canvas point under (px, py) — viewport coordinates — where it is. */
export function zoomAt(v: View, px: number, py: number, factor: number): View {
  const k = clampZoom(v.k * factor)
  const r = k / v.k
  return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }
}

/** The whole canvas (w × h) centered in the viewport (vw × vh), never enlarged past 1:1. */
export function fitView(w: number, h: number, vw: number, vh: number, pad = 8): View {
  if (!w || !h || !vw || !vh) return { x: 0, y: 0, k: 1 }
  const k = clampZoom(Math.min(1, (vw - pad * 2) / w, (vh - pad * 2) / h))
  return { k, x: (vw - w * k) / 2, y: (vh - h * k) / 2 }
}

/**
 * Keeps at least `keep` px of the canvas inside the viewport, so a fling can't
 * lose the graph off-screen.
 */
export function clampPan(v: View, w: number, h: number, vw: number, vh: number, keep = 48): View {
  const cw = w * v.k
  const ch = h * v.k
  return {
    k: v.k,
    x: Math.min(vw - Math.min(keep, cw), Math.max(Math.min(keep, cw) - cw, v.x)),
    y: Math.min(vh - Math.min(keep, ch), Math.max(Math.min(keep, ch) - ch, v.y)),
  }
}

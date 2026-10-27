// Double-click with a mouse, double-tap on touch: two clicks on the same item
// within a short gap. (iOS Safari doesn't reliably fire `dblclick`, so this
// counts ordinary clicks instead — the same code serves both.)
const GAP_MS = 350

export function useDoubleTap() {
  let last: { key: string; at: number } | null = null
  /** Call on every click; true when it completes a double on the same key. */
  return function isDouble(key: string): boolean {
    const now = Date.now()
    const hit = !!last && last.key === key && now - last.at < GAP_MS
    last = hit ? null : { key, at: now }
    return hit
  }
}

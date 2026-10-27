// A draggable divider that sets a column's width (desktop), remembered per
// device. `side` says where the column is: dragging toward the map shrinks a
// left column and grows a right one. Arrow keys nudge it (Shift: more), a
// double-click resets it. Pointer capture plus window listeners, so a fast drag
// over the map doesn't lose it.
import { onBeforeUnmount, ref } from 'vue'

export function useSplitter(opts: { key: string; initial: number; min: number; maxShare: number; side: 'left' | 'right' }) {
  const read = () => {
    try {
      return Number(localStorage.getItem(opts.key)) || 0
    } catch {
      return 0
    }
  }
  const save = (v: number | null) => {
    try {
      if (v === null) localStorage.removeItem(opts.key)
      else localStorage.setItem(opts.key, String(v))
    } catch {
      /* per-device convenience only */
    }
  }
  const clamp = (w: number) => Math.min(Math.max(opts.min, Math.round(window.innerWidth * opts.maxShare)), Math.max(opts.min, Math.round(w)))
  const width = ref(clamp(read() || opts.initial))
  const sign = opts.side === 'left' ? 1 : -1

  let from: { x: number; w: number } | null = null
  function move(e: PointerEvent) {
    if (from) width.value = clamp(from.w + sign * (e.clientX - from.x))
  }
  function end() {
    from = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    save(width.value)
  }
  function start(e: PointerEvent) {
    from = { x: e.clientX, w: width.value }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* the window listeners still hear it */
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }
  function key(e: KeyboardEvent) {
    const step = (e.shiftKey ? 64 : 16) * sign
    if (e.key === 'ArrowLeft') width.value = clamp(width.value - step)
    else if (e.key === 'ArrowRight') width.value = clamp(width.value + step)
    else return
    e.preventDefault()
    save(width.value)
  }
  onBeforeUnmount(() => from && end())
  function reset() {
    width.value = opts.initial
    save(null)
  }
  return { width, start, key, reset }
}

// A draggable divider that sets a column's width (desktop) or a bottom panel's
// height (the setup mode's mini map), remembered per device. `side` says where
// the panel is: dragging toward the map shrinks a left column and grows a right
// one; dragging up grows a bottom panel. Arrow keys nudge it (Shift: more), a
// double-click resets it. Pointer capture plus window listeners, so a fast drag
// over the map doesn't lose it.
import { onBeforeUnmount, ref } from 'vue'

export function useSplitter(opts: { key: string; initial: number; min: number; maxShare: number; side: 'left' | 'right' | 'bottom' }) {
  const vertical = opts.side === 'bottom'
  const room = () => (vertical ? window.innerHeight : window.innerWidth)
  const at = (e: PointerEvent) => (vertical ? e.clientY : e.clientX)
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
  const clamp = (w: number) => Math.min(Math.max(opts.min, Math.round(room() * opts.maxShare)), Math.max(opts.min, Math.round(w)))
  const size = ref(clamp(read() || opts.initial))
  const sign = opts.side === 'left' ? 1 : -1

  let from: { at: number; size: number } | null = null
  function move(e: PointerEvent) {
    if (from) size.value = clamp(from.size + sign * (at(e) - from.at))
  }
  function end() {
    from = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    save(size.value)
  }
  function start(e: PointerEvent) {
    from = { at: at(e), size: size.value }
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
    if (e.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) size.value = clamp(size.value - step)
    else if (e.key === (vertical ? 'ArrowDown' : 'ArrowRight')) size.value = clamp(size.value + step)
    else return
    e.preventDefault()
    save(size.value)
  }
  onBeforeUnmount(() => from && end())
  function reset() {
    size.value = opts.initial
    save(null)
  }
  return { size, start, key, reset }
}

// Tap-and-hold on touch, right-click with a mouse: one "open the menu for
// this item" gesture. Pointer events with a timer, because iOS Safari never
// fires `contextmenu` for a long press. Moving the finger (a scroll) cancels;
// the item's element should set `-webkit-touch-callout: none` and
// `user-select: none` so iOS doesn't show its own callout first.

const HOLD_MS = 500
const SLOP_PX = 10
/** Long-pressing these does what they normally do (type, select, drag). */
const IGNORE = 'input, textarea, select, button, .handle, [data-no-hold]'

export function useLongPress(onPress: (id: string, at: { x: number; y: number }) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let start: { x: number; y: number } | null = null

  function cancel() {
    clearTimeout(timer)
    timer = undefined
    start = null
  }
  function down(e: PointerEvent, id: string) {
    if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest(IGNORE)) return
    start = { x: e.clientX, y: e.clientY }
    const at = start
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      start = null
      navigator.vibrate?.(10)
      onPress(id, at)
    }, HOLD_MS)
  }
  function move(e: PointerEvent) {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP_PX) cancel()
  }
  function context(e: MouseEvent, id: string) {
    if ((e.target as HTMLElement).closest('input, textarea')) return // keep the native menu for text
    e.preventDefault()
    cancel()
    onPress(id, { x: e.clientX, y: e.clientY })
  }
  /** Spread onto the item: `v-on="holdHandlers(id)"`. */
  const holdHandlers = (id: string) => ({
    pointerdown: (e: PointerEvent) => down(e, id),
    pointermove: move,
    pointerup: cancel,
    pointercancel: cancel,
    pointerleave: cancel,
    contextmenu: (e: MouseEvent) => context(e, id),
  })
  return { holdHandlers, cancel }
}

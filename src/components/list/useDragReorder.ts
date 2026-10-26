// Drag a row's ≡ handle to reorder a list, with pointer events (HTML5
// drag-and-drop doesn't exist on iOS). Rows are the list element's direct
// `li[data-id]` children; the handle needs `touch-action: none`.
//
// While a drag is on, moves and the release are also heard on the window:
// moving a row in the DOM can drop the handle's pointer capture (iOS), and a
// release nobody hears leaves the row stuck looking dragged.
import { onBeforeUnmount, ref, type Ref } from 'vue'

export function useDragReorder(listEl: Ref<HTMLElement | undefined>, ids: () => string[], onReorder: (ids: string[]) => void, onStart?: () => void) {
  const dragging = ref<string | null>(null)
  let order: string[] = []

  function onHandleDown(e: PointerEvent, id: string) {
    e.preventDefault()
    try {
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* no capture (a pointer the browser doesn't know): the window listeners still follow it */
    }
    dragging.value = id
    order = ids()
    window.addEventListener('pointermove', onHandleMove)
    window.addEventListener('pointerup', onHandleUp)
    window.addEventListener('pointercancel', onHandleUp)
    onStart?.()
  }
  function onHandleMove(e: PointerEvent) {
    if (!dragging.value || !listEl.value) return
    const rows = [...listEl.value.querySelectorAll<HTMLElement>(':scope > li[data-id]')]
    // Target index: the first row whose middle is below the pointer.
    let to = rows.findIndex((r) => {
      const b = r.getBoundingClientRect()
      return e.clientY < b.top + b.height / 2
    })
    if (to < 0) to = rows.length - 1
    const from = order.indexOf(dragging.value)
    if (to === from || from < 0) return
    order.splice(from, 1)
    order.splice(to, 0, dragging.value)
    onReorder([...order])
  }
  function onHandleUp() {
    dragging.value = null
    window.removeEventListener('pointermove', onHandleMove)
    window.removeEventListener('pointerup', onHandleUp)
    window.removeEventListener('pointercancel', onHandleUp)
  }
  onBeforeUnmount(onHandleUp)
  return { dragging, onHandleDown, onHandleMove, onHandleUp }
}

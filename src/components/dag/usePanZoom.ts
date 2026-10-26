// Pan and zoom a canvas inside a viewport element (the workspace graph).
//   Mouse / pen: click and drag to pan; Shift + wheel to zoom; a trackpad
//     pinch arrives as Ctrl + wheel (Chrome, Firefox, Edge) or as Safari's
//     gesture events — both zoom.
//   Touch: one finger still scrolls the page; touch and hold (~0.35 s,
//     without moving) starts panning, then drag; two fingers pinch to zoom.
// A drag or pinch swallows the click that would follow, so it never also
// taps a node. The maths is in lib/panZoom.ts.
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { clampPan, fitView, zoomAt, type View } from '../../lib/panZoom'

const DRAG_SLOP = 4 // px a mouse moves before a press becomes a pan
const HOLD_MS = 350
const HOLD_SLOP = 8 // px a finger may wander while holding

export function usePanZoom(viewport: Ref<HTMLElement | undefined>, size: () => { w: number; h: number }) {
  const view = ref<View>({ x: 0, y: 0, k: 1 })
  /** True while a hold-to-pan or a drag is moving the canvas (for a visual cue). */
  const panning = ref(false)

  const box = () => viewport.value?.getBoundingClientRect()
  const set = (v: View) => {
    const el = viewport.value
    const { w, h } = size()
    view.value = el ? clampPan(v, w, h, el.clientWidth, el.clientHeight) : v
  }
  function fit() {
    const el = viewport.value
    const { w, h } = size()
    if (el) view.value = fitView(w, h, el.clientWidth, el.clientHeight)
  }
  /** Zoom about the viewport's middle (the ＋ / − buttons). */
  function zoomBy(factor: number) {
    const el = viewport.value
    if (el) set(zoomAt(view.value, el.clientWidth / 2, el.clientHeight / 2, factor))
  }
  const zoomAtClient = (cx: number, cy: number, factor: number) => {
    const b = box()
    if (b) set(zoomAt(view.value, cx - b.left, cy - b.top, factor))
  }
  const panBy = (dx: number, dy: number) => set({ ...view.value, x: view.value.x + dx, y: view.value.y + dy })

  // A pan or pinch just happened: the next click is part of it, not a tap.
  let swallowClick = false
  const markGesture = () => {
    swallowClick = true
    setTimeout(() => (swallowClick = false), 400)
  }
  function onClickCapture(e: MouseEvent) {
    if (!swallowClick) return
    e.stopPropagation()
    e.preventDefault()
    swallowClick = false
  }

  // ── mouse / pen ──────────────────────────────────────────────────────────
  let drag: { x: number; y: number; moved: boolean } | null = null
  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'touch' || e.button !== 0) return
    drag = { x: e.clientX, y: e.clientY, moved: false }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    drag.moved = true
    panning.value = true
    drag.x = e.clientX
    drag.y = e.clientY
    panBy(dx, dy)
  }
  function onPointerUp() {
    if (drag?.moved) markGesture()
    drag = null
    panning.value = false
    window.removeEventListener('pointermove', onPointerMove)
  }

  function onWheel(e: WheelEvent) {
    // Plain wheel / two-finger scroll keeps scrolling the page.
    if (!e.shiftKey && !e.ctrlKey) return
    e.preventDefault()
    // Shift turns a vertical wheel into deltaX on some systems.
    const delta = e.deltaY || e.deltaX
    const unit = e.deltaMode === 1 ? 16 : 1 // lines → px
    zoomAtClient(e.clientX, e.clientY, Math.exp(-delta * unit * (e.ctrlKey ? 0.01 : 0.0025)))
  }

  // Safari (macOS trackpad pinch; iOS too, but touches handle that).
  let gestureK = 1
  let touching = 0
  type GestureLike = Event & { scale: number; clientX: number; clientY: number }
  function onGestureStart(e: Event) {
    e.preventDefault()
    gestureK = view.value.k
  }
  function onGestureChange(e: Event) {
    e.preventDefault()
    if (touching) return
    const g = e as GestureLike
    zoomAtClient(g.clientX, g.clientY, (gestureK * g.scale) / view.value.k)
  }

  // ── touch ────────────────────────────────────────────────────────────────
  let hold: { timer: ReturnType<typeof setTimeout> | null; x: number; y: number; active: boolean } | null = null
  let pinch: { dist: number; mx: number; my: number } | null = null
  const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 })
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  const endHold = () => {
    if (hold?.timer) clearTimeout(hold.timer)
    hold = null
  }

  function onTouchStart(e: TouchEvent) {
    touching = e.touches.length
    if (e.touches.length === 1) {
      const t = e.touches[0]
      hold = {
        x: t.clientX,
        y: t.clientY,
        active: false,
        timer: setTimeout(() => {
          if (!hold) return
          hold.timer = null
          hold.active = true
          panning.value = true
        }, HOLD_MS),
      }
    } else if (e.touches.length === 2) {
      endHold()
      panning.value = false
      const m = mid(e.touches)
      pinch = { dist: dist(e.touches), mx: m.x, my: m.y }
    }
  }
  function onTouchMove(e: TouchEvent) {
    if (pinch && e.touches.length === 2) {
      e.preventDefault()
      const d = dist(e.touches)
      const m = mid(e.touches)
      panBy(m.x - pinch.mx, m.y - pinch.my)
      if (pinch.dist > 0) zoomAtClient(m.x, m.y, d / pinch.dist)
      pinch = { dist: d, mx: m.x, my: m.y }
      return
    }
    if (!hold || e.touches.length !== 1) return
    const t = e.touches[0]
    if (hold.active) {
      e.preventDefault() // the page doesn't scroll while the graph pans
      panBy(t.clientX - hold.x, t.clientY - hold.y)
      hold.x = t.clientX
      hold.y = t.clientY
    } else if (Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > HOLD_SLOP) {
      endHold() // moving before the hold completes: an ordinary page scroll
    }
  }
  function onTouchEnd(e: TouchEvent) {
    touching = e.touches.length
    if (hold?.active || pinch) markGesture()
    if (e.touches.length < 2) pinch = null
    if (e.touches.length === 0) {
      endHold()
      panning.value = false
    }
  }

  // Listeners that must be able to preventDefault are added by hand (not passive).
  onMounted(() => {
    const el = viewport.value
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('click', onClickCapture, true)
  })
  onBeforeUnmount(() => {
    endHold()
    onPointerUp()
  })

  return { view, panning, fit, zoomBy }
}

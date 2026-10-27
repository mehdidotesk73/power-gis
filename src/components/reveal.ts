// v-reveal: scroll an element into view when it appears (or, with a value,
// whenever that value changes to something truthy) — so each step of a flow
// (pick inputs, then the editor) comes to the user's attention. Scrolls only
// as far as needed, inside whatever scrolls (the page, or the pop-out window).
// `v-reveal.late` waits out a double-click first: a scroll between the two
// clicks would move the target out from under the second one.
import type { Directive } from 'vue'

const LATE_MS = 400 // just past useDoubleTap's gap

function reveal(el: HTMLElement, late = false) {
  if (late) return void setTimeout(() => reveal(el), LATE_MS)
  requestAnimationFrame(() => {
    // Taller than the screen: bring its top in (where the form starts), else just enough to show it all.
    const tall = el.getBoundingClientRect().height > window.innerHeight * 0.85
    el.scrollIntoView?.({ behavior: 'smooth', block: tall ? 'start' : 'nearest' })
  })
}

export const vReveal: Directive<HTMLElement, unknown> = {
  mounted(el, b) {
    if (b.value === undefined || b.value) reveal(el, b.modifiers.late)
  },
  updated(el, b) {
    if (b.value && b.value !== b.oldValue) reveal(el, b.modifiers.late)
  },
}

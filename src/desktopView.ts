// "Desktop view" on a phone: lay the page out at a laptop's width and let the
// browser shrink it to fit the screen, so desktop-only layout (side panel,
// docked assistant, splitters) can be seen and tested on the device. Turning
// the phone sideways keeps the phone layout on purpose. Remembered on this
// device; switching reloads, since the viewport is read at start-up.

const KEY = 'powergis.desktopView'
/** Wide enough for every desktop layout (the side panel, the map and the docked assistant). */
export const DESKTOP_WIDTH = 1280

export function desktopView(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setDesktopView(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // Storage blocked: nothing to remember, the reload shows the default.
  }
  location.reload()
}

/** A phone or tablet, where the toggle makes sense (or it's on and must be turnable off). */
export const offerDesktopView = () => desktopView() || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)

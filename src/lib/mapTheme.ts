// Colours the map draws with. MapLibre paint can't read CSS variables, so the
// map's share of the dark theme (src/styles/vars.css) lives here, in one place.

/** Search matches (Find): soft orchid, in neither viridis nor the categorical palettes. */
export const HIGHLIGHT = '#f0a3e4'
/** The hovered / tapped feature's outline: reads over any data colour on a dark map. */
export const SELECTED = '#ffffff'
/** Default fill-pattern ink (hatch, dots…) and vector arrows: light, for a dark basemap. */
export const PATTERN_INK = '#e7eaf3'
export const ARROW = '#e7eaf3'
/** Background when the basemap can't load. */
export const MAP_BG = '#0e131d'
/** Basemap labels (drawn above the data): light text in a dark halo, legible over any fill. */
export const LABEL_TEXT = '#e7eaf3'
export const LABEL_HALO = 'rgba(11, 15, 24, 0.9)'

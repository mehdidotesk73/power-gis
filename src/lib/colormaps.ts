// Colormaps as evenly spaced hex stops. Sequential maps run low → high.

export const COLORMAPS = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  plasma: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  ylOrRd: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'],
  blues: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
  greens: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'],
  rdBu: ['#67001f', '#b2182b', '#d6604d', '#f4a582', '#fddbc7', '#f7f7f7', '#d1e5f0', '#92c5de', '#4393c3', '#2166ac', '#053061'],
} as const

export type ColormapName = keyof typeof COLORMAPS

/** Categorical palette (Tableau 10). */
export const CATEGORICAL = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac']

export function colormapStops(name: ColormapName, reverse = false): string[] {
  const stops = [...COLORMAPS[name]]
  return reverse ? stops.reverse() : stops
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Sample a colormap at t ∈ [0,1]. */
export function sampleColormap(name: ColormapName, t: number, reverse = false): string {
  const stops = colormapStops(name, reverse)
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const a = hexToRgb(stops[i])
  const b = hexToRgb(stops[i + 1])
  const f = x - i
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f))
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}

export function cssGradient(name: ColormapName, reverse = false): string {
  return `linear-gradient(to right, ${colormapStops(name, reverse).join(', ')})`
}

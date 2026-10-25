// Categorical palettes, for anything that colors categories (map layers,
// legends, later charts). Pure: names in, hex colors out.
//
//   12, 24, 60  fixed lists of distinct colors. Each extends the smaller one
//               (the first 12 of the 24 are the 12), so a category keeps its
//               color when a bigger palette is picked. More categories than
//               colors → the colors repeat.
//   many        any number of colors: the 12 hues, each in as many lighter /
//               darker variations as needed. Consecutive categories get
//               different hues.
//   auto        the smallest fixed palette that fits, else many.
//
// The fixed lists are built once, deterministically: start from Tableau 10's
// first nine (its grey dropped) and repeatedly add the candidate color
// farthest (in CIELAB) from every color chosen so far, among colors bright
// and saturated enough to read on light and dark backgrounds, but no
// more saturated than Tableau's own colors (so the set stays one family).

export type PaletteName = 'auto' | 'p12' | 'p24' | 'p60' | 'many'
export const PALETTE_LABELS: Record<PaletteName, string> = {
  auto: 'Auto (fits the values)',
  p12: '12 colors',
  p24: '24 colors',
  p60: '60 colors',
  many: 'Many (variations)',
}

const SEED = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f']

// ── color math (sRGB ↔ CIELAB, D65) ───────────────────────────────────────

type Lab = [number, number, number]

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
const fInv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27))
const WHITE = [0.95047, 1, 1.08883]

export function hexToLab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => toLinear(c / 255))
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / WHITE[0]
  const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / WHITE[1]
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / WHITE[2]
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

export function labToHex([L, a, b]: Lab): string {
  const fy = (L + 16) / 116
  const [x, y, z] = [fInv(fy + a / 500) * WHITE[0], fInv(fy) * WHITE[1], fInv(fy - b / 200) * WHITE[2]]
  const rgb = [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z]
  return '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, fromLinear(c))) * 255).toString(16).padStart(2, '0')).join('')
}

const dist = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

// ── fixed palettes ─────────────────────────────────────────────────────────

function buildFixed(size: number): string[] {
  const step = 15
  const candidates: { hex: string; lab: Lab }[] = []
  for (let r = 0; r <= 255; r += step)
    for (let g = 0; g <= 255; g += step)
      for (let b = 0; b <= 255; b += step) {
        const hex = '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')
        const lab = hexToLab(hex)
        const chroma = Math.hypot(lab[1], lab[2])
        if (lab[0] >= 40 && lab[0] <= 82 && chroma >= 22 && chroma <= 62) candidates.push({ hex, lab })
      }
  const chosen = SEED.map(hexToLab)
  const out = [...SEED]
  // Distance from each candidate to its nearest chosen color, kept up to date.
  const near = candidates.map((c) => Math.min(...chosen.map((x) => dist(c.lab, x))))
  while (out.length < size) {
    let best = 0
    for (let i = 1; i < candidates.length; i++) if (near[i] > near[best]) best = i
    const pick = candidates[best]
    out.push(pick.hex)
    for (let i = 0; i < candidates.length; i++) near[i] = Math.min(near[i], dist(candidates[i].lab, pick.lab))
  }
  return out
}

const P60 = buildFixed(60)
export const PALETTES: Record<'p12' | 'p24' | 'p60', readonly string[]> = {
  p12: P60.slice(0, 12),
  p24: P60.slice(0, 24),
  p60: P60,
}

// ── many ───────────────────────────────────────────────────────────────────

/** `n` colors: the 12 hues, each in ⌈n/12⌉ lightness variations (the original first). */
export function manyColors(n: number, base: readonly string[] = PALETTES.p12): string[] {
  const variants = Math.max(1, Math.ceil(n / base.length))
  // Lightness offsets: 0, then alternately darker / lighter, spread over ±24.
  const spread = 24
  const offsets = Array.from({ length: variants }, (_, j) => (j === 0 ? 0 : (j % 2 ? -1 : 1) * Math.ceil(j / 2) * (spread / Math.ceil((variants - 1) / 2 || 1))))
  const labs = base.map(hexToLab)
  return Array.from({ length: n }, (_, i) => {
    const [L, a, b] = labs[i % base.length]
    const dL = offsets[Math.floor(i / base.length)]
    return dL === 0 ? base[i % base.length] : labToHex([Math.min(92, Math.max(22, L + dL)), a, b])
  })
}

/** Colors for `n` categories, in order. Fixed palettes repeat when `n` is larger than they are. */
export function paletteColors(name: PaletteName, n: number): string[] {
  if (name === 'auto') name = n <= 12 ? 'p12' : n <= 24 ? 'p24' : n <= 60 ? 'p60' : 'many'
  if (name === 'many') return manyColors(n)
  const p = PALETTES[name]
  return Array.from({ length: n }, (_, i) => p[i % p.length])
}

/** How many distinct colors a palette has for `n` categories (fewer than `n` means repeats). */
export function paletteSize(name: PaletteName, n: number): number {
  if (name === 'many' || (name === 'auto' && n > 60)) return n
  if (name === 'auto') return n
  return PALETTES[name].length
}

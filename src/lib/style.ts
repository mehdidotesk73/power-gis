// Declarative styles for map layers, and their translation to MapLibre
// expressions + legend descriptions. Pure functions: no map, no DOM.
//
// Scalars encode with color (constant / colormap / categorical), opacity
// (constant / by field) and fill pattern (none / constant / by field).
// Vectors encode as arrows: direction from the vector, size from magnitude,
// plus the same color and opacity encodings.

import { CATEGORICAL, colormapStops, cssGradient, type ColormapName } from './colormaps'
import { distinctValues, numericValues, type LayerFeature } from './schema'

/** A MapLibre style expression (kept loose so this module stays map-library free). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Expr = any[]

export type ColorEncoding =
  | { kind: 'constant'; color: string }
  | {
      kind: 'colormap'
      field: string
      colormap: ColormapName
      reverse?: boolean
      scale?: 'linear' | 'log'
      /** Fixed [min, max]; defaults to the data's range. */
      domain?: [number, number]
      nullColor?: string
    }
  | {
      kind: 'categorical'
      field: string
      /** Explicit value → color; unlisted values get palette colors in frequency order. */
      colors?: Record<string, string>
      maxCategories?: number
      otherColor?: string
    }

export type OpacityEncoding =
  | { kind: 'constant'; value: number }
  | { kind: 'field'; field: string; range: [number, number]; domain?: [number, number] }

export const PATTERNS = ['hatch', 'backhatch', 'cross', 'dots', 'horizontal', 'vertical'] as const
export type PatternKind = (typeof PATTERNS)[number]

export type PatternEncoding =
  | { kind: 'none' }
  | { kind: 'constant'; pattern: PatternKind; color?: string; opacity?: number }
  | {
      kind: 'field'
      field: string
      /** Value (stringified) → pattern. Values not listed get no pattern. */
      patterns: Record<string, PatternKind>
      color?: string
      opacity?: number
    }

export interface ScalarStyle {
  color: ColorEncoding
  opacity: OpacityEncoding
  pattern: PatternEncoding
  outline?: { color: string; width: number; opacity?: number }
  /** Point radius / line width in px. */
  size?: number
}

export type VectorComponents =
  | { kind: 'uv'; u: string; v: string }
  /** direction in degrees clockwise from north, pointing where the vector goes. */
  | { kind: 'polar'; magnitude: string; direction: string }

export interface VectorStyle {
  components: VectorComponents
  /** Color by MAGNITUDE_FIELD to color by vector length. */
  color: ColorEncoding
  opacity: OpacityEncoding
  /** Arrow scale (1 = 24px) at the low and high end of the magnitude domain. */
  size: { min: number; max: number; domain?: [number, number] }
}

/** Derived properties the vector layer adds to every feature. */
export const MAGNITUDE_FIELD = '_magnitude'
export const DIRECTION_FIELD = '_direction'

// ── domains ────────────────────────────────────────────────────────────────

export function dataDomain(features: LayerFeature[], field: string): [number, number] {
  const vals = numericValues(features, field)
  if (!vals.length) return [0, 1]
  let lo = Infinity
  let hi = -Infinity
  for (const v of vals) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return [lo, hi]
}

/** n stop values across the domain, strictly ascending (as MapLibre requires). */
export function stopValues(domain: [number, number], n: number, scale: 'linear' | 'log' = 'linear'): number[] {
  let [lo, hi] = domain
  if (scale === 'log') {
    lo = Math.max(lo, 1e-9)
    hi = Math.max(hi, lo * 10)
    const a = Math.log(lo)
    const b = Math.log(hi)
    return Array.from({ length: n }, (_, i) => Math.exp(a + ((b - a) * i) / (n - 1)))
  }
  if (hi <= lo) hi = lo + 1
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1))
}

// ── color ──────────────────────────────────────────────────────────────────

export function categoricalColors(
  enc: Extract<ColorEncoding, { kind: 'categorical' }>,
  features: LayerFeature[],
): { value: string; color: string }[] {
  const max = enc.maxCategories ?? 9
  const values = distinctValues(features, enc.field).slice(0, max)
  let next = 0
  return values.map((value) => {
    const color = enc.colors?.[value] ?? CATEGORICAL[next++ % CATEGORICAL.length]
    return { value, color }
  })
}

export function colorExpression(enc: ColorEncoding, features: LayerFeature[]): Expr | string {
  if (enc.kind === 'constant') return enc.color
  const get: Expr = ['get', enc.field]
  if (enc.kind === 'colormap') {
    const colors = colormapStops(enc.colormap, enc.reverse)
    const values = stopValues(enc.domain ?? dataDomain(features, enc.field), colors.length, enc.scale)
    const ramp = ['interpolate', ['linear'], ['to-number', get], ...values.flatMap((v, i) => [v, colors[i]])]
    return ['case', ['==', ['typeof', get], 'number'], ramp, enc.nullColor ?? 'rgba(0,0,0,0)'] as Expr
  }
  const cats = categoricalColors(enc, features)
  const other = enc.otherColor ?? '#9e9e9e'
  if (!cats.length) return other
  return ['match', ['to-string', get], ...cats.flatMap((c) => [c.value, c.color]), other] as Expr
}

// ── opacity ────────────────────────────────────────────────────────────────

export function opacityExpression(enc: OpacityEncoding, features: LayerFeature[]): Expr | number {
  if (enc.kind === 'constant') return enc.value
  const [lo, hi] = enc.domain ?? dataDomain(features, enc.field)
  const get: Expr = ['get', enc.field]
  const ramp = ['interpolate', ['linear'], ['to-number', get], lo, enc.range[0], hi > lo ? hi : lo + 1, enc.range[1]]
  return ['case', ['==', ['typeof', get], 'number'], ramp, enc.range[0]] as Expr
}

// ── pattern ────────────────────────────────────────────────────────────────

/** One entry per pattern layer to draw: which pattern, and which features get it. */
export function patternGroups(enc: PatternEncoding): { pattern: PatternKind; filter: Expr | null }[] {
  if (enc.kind === 'none') return []
  if (enc.kind === 'constant') return [{ pattern: enc.pattern, filter: null }]
  const byPattern = new Map<PatternKind, string[]>()
  for (const [value, p] of Object.entries(enc.patterns)) {
    if (!byPattern.has(p)) byPattern.set(p, [])
    byPattern.get(p)!.push(value)
  }
  return [...byPattern].map(([pattern, values]) => ({
    pattern,
    filter: ['in', ['to-string', ['get', enc.field]], ['literal', values]] as Expr,
  }))
}

export function patternImageId(pattern: PatternKind, color: string): string {
  return `pat-${pattern}-${color.replace(/[^a-z0-9]/gi, '')}`
}

// ── vectors ────────────────────────────────────────────────────────────────

/** Magnitude and compass direction (degrees clockwise from north) of a feature's vector. */
const finite = (x: unknown): number | null => (x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null)

export function vectorOf(props: Record<string, unknown>, c: VectorComponents): { magnitude: number; direction: number } | null {
  if (c.kind === 'uv') {
    const u = finite(props[c.u])
    const v = finite(props[c.v])
    if (u === null || v === null) return null
    const deg = (Math.atan2(u, v) * 180) / Math.PI
    return { magnitude: Math.hypot(u, v), direction: (deg + 360) % 360 }
  }
  const m = finite(props[c.magnitude])
  const d = finite(props[c.direction])
  if (m === null || d === null) return null
  return { magnitude: m, direction: ((d % 360) + 360) % 360 }
}

export function sizeExpression(style: VectorStyle, features: LayerFeature[]): Expr {
  const [lo, hi] = style.size.domain ?? dataDomain(features, MAGNITUDE_FIELD)
  return ['interpolate', ['linear'], ['get', MAGNITUDE_FIELD], lo, style.size.min, hi > lo ? hi : lo + 1, style.size.max]
}

// ── legend ─────────────────────────────────────────────────────────────────

export type LegendEntry =
  | { kind: 'ramp'; title: string; gradient: string; min: number; max: number; scale: 'linear' | 'log' }
  | { kind: 'swatches'; title: string; items: { label: string; color: string; pattern?: PatternKind }[] }

export function colorLegend(enc: ColorEncoding, features: LayerFeature[], title: string): LegendEntry | null {
  if (enc.kind === 'constant') return null
  if (enc.kind === 'colormap') {
    const [min, max] = enc.domain ?? dataDomain(features, enc.field)
    return { kind: 'ramp', title, gradient: cssGradient(enc.colormap, enc.reverse), min, max, scale: enc.scale ?? 'linear' }
  }
  const items = categoricalColors(enc, features).map((c) => ({ label: c.value, color: c.color }))
  return { kind: 'swatches', title, items }
}

export function patternLegend(enc: PatternEncoding, title: string): LegendEntry | null {
  if (enc.kind !== 'field') return null
  const color = enc.color ?? '#222222'
  return {
    kind: 'swatches',
    title,
    items: Object.entries(enc.patterns).map(([label, pattern]) => ({ label, color, pattern })),
  }
}

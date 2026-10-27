// Declarative styles for map layers, and their translation to MapLibre
// expressions + legend descriptions. Pure functions: no map, no DOM.
//
// Scalars encode with color (constant / colormap / categorical), opacity
// (constant / by field) and fill pattern (none / constant / by field).
// Vectors encode as arrows: direction from the vector, size from magnitude,
// plus the same color and opacity encodings.

import { PATTERN_INK } from './mapTheme'
import { colormapStops, cssGradient, type ColormapName } from './colormaps'
import { paletteColors, type PaletteName } from './palettes'
import { distinctValues, numericValues, parseVector, type LayerFeature } from './schema'

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
      /** Explicit value → color; every other value gets a palette color, in sorted order. */
      colors?: Record<string, string>
      /** Default 'auto': the smallest fixed palette that fits, else 'many'. */
      palette?: PaletteName
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
  /** One field holding a vector value ({u, v}). */
  | { kind: 'vector'; field: string }

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

/**
 * The value range a colormap spans: its fixed domain, else the data's. A log
 * scale starts at the smallest positive value (values at or below it take the
 * first color), so a few zeros don't squash the whole ramp.
 */
export function colormapDomain(enc: Extract<ColorEncoding, { kind: 'colormap' }>, features: LayerFeature[]): [number, number] {
  if (enc.domain) return enc.domain
  if (enc.scale !== 'log') return dataDomain(features, enc.field)
  const pos = numericValues(features, enc.field).filter((v) => v > 0)
  if (!pos.length) return [1, 10]
  let lo = Infinity
  let hi = -Infinity
  for (const v of pos) {
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
  // Every value gets a color. Sorted (numbers numerically), so a value keeps its
  // color when others are added or counts change.
  const values = distinctValues(features, enc.field).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const free = values.filter((v) => !enc.colors?.[v])
  const colors = paletteColors(enc.palette ?? 'auto', free.length)
  const byValue = new Map(free.map((v, i) => [v, colors[i]]))
  return values.map((value) => ({ value, color: enc.colors?.[value] ?? byValue.get(value)! }))
}

export function colorExpression(enc: ColorEncoding, features: LayerFeature[]): Expr | string {
  if (enc.kind === 'constant') return enc.color
  const get: Expr = ['get', enc.field]
  if (enc.kind === 'colormap') {
    const colors = colormapStops(enc.colormap, enc.reverse)
    const values = stopValues(colormapDomain(enc, features), colors.length, enc.scale)
    const ramp = ['interpolate', ['linear'], ['to-number', get], ...values.flatMap((v, i) => [v, colors[i]])]
    return ['case', ['==', ['typeof', get], 'number'], ramp, enc.nullColor ?? 'rgba(0,0,0,0)'] as Expr
  }
  const cats = categoricalColors(enc, features)
  const other = '#9e9e9e' // values not seen when the style was built
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
  if (c.kind === 'vector') {
    const vec = parseVector(props[c.field])
    return vec ? vectorOf({ u: vec.u, v: vec.v }, { kind: 'uv', u: 'u', v: 'v' }) : null
  }
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
  /** `clippedLow` / `clippedHigh`: some values lie beyond the ramp's end (they take its end color). */
  | { kind: 'ramp'; title: string; gradient: string; min: number; max: number; scale: 'linear' | 'log'; clippedLow?: boolean; clippedHigh?: boolean }
  | { kind: 'swatches'; title: string; items: { label: string; color: string; pattern?: PatternKind }[] }

const legendLabel = (v: string) => (v === 'true' ? 'Yes' : v === 'false' ? 'No' : v)

export function colorLegend(enc: ColorEncoding, features: LayerFeature[], title: string): LegendEntry | null {
  if (enc.kind === 'constant') return null
  if (enc.kind === 'colormap') {
    const [min, max] = colormapDomain(enc, features)
    const [lo, hi] = dataDomain(features, enc.field)
    const has = numericValues(features, enc.field).length > 0
    return {
      kind: 'ramp',
      title,
      gradient: cssGradient(enc.colormap, enc.reverse),
      min,
      max,
      scale: enc.scale ?? 'linear',
      ...(has && lo < min ? { clippedLow: true } : {}),
      ...(has && hi > max ? { clippedHigh: true } : {}),
    }
  }
  const items = categoricalColors(enc, features).map((c) => ({ label: legendLabel(c.value), color: c.color }))
  return { kind: 'swatches', title, items }
}

export function patternLegend(enc: PatternEncoding, title: string): LegendEntry | null {
  if (enc.kind !== 'field') return null
  const color = enc.color ?? PATTERN_INK
  return {
    kind: 'swatches',
    title,
    items: Object.entries(enc.patterns).map(([label, pattern]) => ({ label: legendLabel(label), color, pattern })),
  }
}

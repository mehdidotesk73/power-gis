// The data model every map layer is built on.
//
// A layer is a set of GeoJSON features of one geometry kind plus a typed field
// schema. The field types are deliberately small — the primitives below and
// list/dict/struct compositions of them — so they round-trip cleanly to ArcGIS
// (see arcgis.ts) and render generically in panels (see PropertyValue.vue).

import type { Feature, Geometry } from 'geojson'

export type PrimitiveType = 'int' | 'double' | 'string' | 'datetime' | 'boolean' | 'vector'

/**
 * A 2-D vector: `u` east and `v` north components, in the data's units.
 * A map primitive like a number — vector columns are drawn as arrows.
 */
export interface Vector {
  u: number
  v: number
}

export function isVector(v: unknown): v is Vector {
  return !!v && typeof v === 'object' && typeof (v as Vector).u === 'number' && typeof (v as Vector).v === 'number'
}

/**
 * A vector from a cell: {u, v} / {x, y} objects, [u, v] arrays, or text like
 * "[3, -1]", "(3, -1)", "3,-1" or '{"u":3,"v":-1}'. Null if it isn't one.
 */
export function parseVector(raw: unknown): Vector | null {
  if (raw === null || raw === undefined) return null
  if (isVector(raw)) return { u: raw.u, v: raw.v }
  if (Array.isArray(raw)) return raw.length === 2 && raw.every((n) => typeof n === 'number' && Number.isFinite(n)) ? { u: raw[0], v: raw[1] } : null
  if (typeof raw === 'object') {
    const o = raw as { x?: unknown; y?: unknown }
    return typeof o.x === 'number' && typeof o.y === 'number' ? { u: o.x, v: o.y } : null
  }
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s.startsWith('{')) {
    try {
      return parseVector(JSON.parse(s))
    } catch {
      return null
    }
  }
  const m = /^[[(]?\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*[,;\s]\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*[\])]?$/.exec(s)
  // A bare "3,1" only counts with brackets or a separator — "3.1" alone is a number.
  return m && /[[(,;]/.test(s) ? { u: Number(m[1]), v: Number(m[2]) } : null
}

export type FieldType =
  | PrimitiveType
  | { kind: 'list'; of: FieldType }
  | { kind: 'dict'; of: FieldType }
  | { kind: 'struct'; fields: FieldDef[] }

export interface FieldDef {
  name: string
  type: FieldType
  /** Human label (ArcGIS "alias"). */
  alias?: string
  description?: string
  unit?: string
}

/** Our three geometry primitives. "region" is a polygon/multipolygon. */
export type GeometryKind = 'point' | 'polyline' | 'region'

export type FeatureProps = Record<string, unknown>
export type LayerFeature = Feature<Geometry, FeatureProps>

export interface LayerData {
  id: string
  name: string
  geometry: GeometryKind
  /** Property holding each feature's unique id (ArcGIS OBJECTID / GlobalID equivalent). */
  idField: string
  /** Property used as the feature's title in tooltips and panels. */
  titleField?: string
  fields: FieldDef[]
  features: LayerFeature[]
  /** Where the data came from — shown in the legend and kept on export. */
  source?: { label: string; url?: string; year?: number }
}

export const isPrimitive = (t: FieldType): t is PrimitiveType => typeof t === 'string'
export const isNumericType = (t: FieldType) => t === 'int' || t === 'double'

export const listOf = (of: FieldType): FieldType => ({ kind: 'list', of })
export const dictOf = (of: FieldType): FieldType => ({ kind: 'dict', of })
export const structOf = (fields: FieldDef[]): FieldType => ({ kind: 'struct', fields })

export function fieldLabel(f: FieldDef): string {
  return f.alias ?? f.name.replace(/_/g, ' ')
}

export function typeName(t: FieldType): string {
  if (isPrimitive(t)) return t
  if (t.kind === 'list') return `list<${typeName(t.of)}>`
  if (t.kind === 'dict') return `dict<${typeName(t.of)}>`
  return `struct{${t.fields.map((f) => `${f.name}: ${typeName(f.type)}`).join(', ')}}`
}

export function geometryKindOf(g: Geometry | null): GeometryKind | null {
  switch (g?.type) {
    case 'Point':
    case 'MultiPoint':
      return 'point'
    case 'LineString':
    case 'MultiLineString':
      return 'polyline'
    case 'Polygon':
    case 'MultiPolygon':
      return 'region'
    default:
      return null
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** Infer the type of a single value. Used when importing data with no schema. */
export function inferValueType(v: unknown): FieldType | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double'
  if (typeof v === 'string') return ISO_DATE.test(v) ? 'datetime' : 'string'
  if (v instanceof Date) return 'datetime'
  if (isVector(v)) return 'vector'
  if (Array.isArray(v)) {
    const inner = mergeTypes(v.map(inferValueType))
    return listOf(inner ?? 'string')
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    return structOf(entries.map(([name, x]) => ({ name, type: inferValueType(x) ?? 'string' })))
  }
  return 'string'
}

/** Widen a set of observed types into one (int+double → double, mismatches → string). */
export function mergeTypes(types: (FieldType | null)[]): FieldType | null {
  const seen = types.filter((t): t is FieldType => t !== null)
  if (!seen.length) return null
  const names = new Set(seen.map(typeName))
  if (names.size === 1) return seen[0]
  if ([...names].every((n) => n === 'int' || n === 'double')) return 'double'
  if (seen.every((t) => !isPrimitive(t) && t.kind === 'list')) {
    return listOf(mergeTypes(seen.map((t) => (t as { of: FieldType }).of)) ?? 'string')
  }
  return 'string'
}

/** Infer a schema from features' properties (first-seen field order). */
export function inferFields(features: LayerFeature[]): FieldDef[] {
  const observed = new Map<string, (FieldType | null)[]>()
  for (const f of features) {
    for (const [k, v] of Object.entries(f.properties ?? {})) {
      if (!observed.has(k)) observed.set(k, [])
      observed.get(k)!.push(inferValueType(v))
    }
  }
  return [...observed].map(([name, ts]) => ({ name, type: mergeTypes(ts) ?? 'string' }))
}

/** Numeric values of a field across features, nulls dropped. */
export function numericValues(features: LayerFeature[], field: string): number[] {
  const out: number[] = []
  for (const f of features) {
    const v = f.properties?.[field]
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v)
  }
  return out
}

/** Distinct values of a field, in descending frequency. */
export function distinctValues(features: LayerFeature[], field: string): string[] {
  const counts = new Map<string, number>()
  for (const f of features) {
    const v = f.properties?.[field]
    if (v === null || v === undefined) continue
    const k = String(v)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k)
}

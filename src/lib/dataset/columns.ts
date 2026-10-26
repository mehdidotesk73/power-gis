// Column typing for raw tables. CSV rows arrive as strings and database rows
// arrive typed; either way each column gets one type, and values are coerced
// to it before aggregation and styling.

import type { DataRecord } from '../data/connectors'
import { geometryKindOf, parseVector, type GeometryKind } from '../schema'
import { geometryFromValue } from './wkt'

/** Geometry columns hold real features (GeoJSON geometries, lon/lat) of one kind. */
export type GeometryColumnType = GeometryKind // 'point' | 'polyline' | 'region'
export type ColumnType = 'int' | 'double' | 'boolean' | 'datetime' | 'string' | 'vector' | GeometryColumnType
export const GEOMETRY_TYPES: readonly GeometryColumnType[] = ['point', 'polyline', 'region']
export const isGeometryColumn = (t: ColumnType): t is GeometryColumnType => (GEOMETRY_TYPES as readonly string[]).includes(t)

export interface ColumnInfo {
  name: string
  type: ColumnType
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const BOOL = /^(true|false)$/i

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

function isGeometryLike(v: unknown): boolean {
  if (v && typeof v === 'object') return 'type' in v && ('coordinates' in v || 'geometry' in v || 'geometries' in v)
  if (typeof v !== 'string') return false
  const s = v.trimStart()
  return /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON)\b/i.test(s) || (s.startsWith('{') && s.includes('"coordinates"'))
}

/** One type per column, judged from up to `sample` non-empty values. */
export function inferColumns(records: DataRecord[], sample = 2000): ColumnInfo[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const r of records.slice(0, 50)) for (const k of Object.keys(r)) if (!seen.has(k)) seen.add(k), names.push(k)

  return names.map((name) => {
    let n = 0
    let num = 0
    let int = 0
    let bool = 0
    let date = 0
    const geom: Record<GeometryKind, number> = { point: 0, polyline: 0, region: 0 }
    let geoms = 0
    let vec = 0
    let leadingZero = false
    for (const r of records) {
      const v = r[name]
      if (isEmpty(v)) continue
      if (++n > sample) break
      if (isGeometryLike(v)) {
        const k = geometryKindOf(geometryFromValue(v))
        if (k) geom[k]++, geoms++
      }
      else if (parseVector(v)) vec++
      else if (typeof v === 'boolean' || (typeof v === 'string' && BOOL.test(v))) bool++
      else if (typeof v === 'number' || (typeof v === 'string' && NUMBER.test(v.trim()))) {
        num++
        // "01001" is a code, not a number: coercing it would drop the zero.
        if (typeof v === 'string' && /^0\d/.test(v.trim())) leadingZero = true
        if (Number.isInteger(Number(v))) int++
      } else if (v instanceof Date || (typeof v === 'string' && ISO_DATE.test(v.trim()))) date++
    }
    n = Math.min(n, sample)
    let type: ColumnType = 'string'
    if (n === 0) type = 'string'
    else if (geoms === n) type = GEOMETRY_TYPES.reduce((a, b) => (geom[b] > geom[a] ? b : a)) // mixed kinds: the most common
    else if (vec === n) type = 'vector'
    else if (bool === n) type = 'boolean'
    else if (num === n && !leadingZero) type = int === n ? 'int' : 'double'
    else if (date === n) type = 'datetime'
    return { name, type }
  })
}

/** A raw value as its column's type (null when empty or unparseable). */
export function coerce(v: unknown, type: ColumnType): unknown {
  if (isEmpty(v)) return null
  switch (type) {
    case 'int':
    case 'double': {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    case 'boolean':
      return v === true || v === 1 || /^(true|1)$/i.test(String(v))
    case 'datetime': {
      const d = v instanceof Date ? v : new Date(String(v))
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
    case 'vector':
      return parseVector(v)
    case 'point':
    case 'polyline':
    case 'region': {
      const g = geometryFromValue(v)
      return g && geometryKindOf(g) === type ? g : null
    }
    default:
      return String(v)
  }
}

export const isNumericColumn = (t: ColumnType) => t === 'int' || t === 'double'

/** Vector columns are drawn as arrows; every other column as a scalar. */
export const isVectorColumn = (t: ColumnType) => t === 'vector'

// Geometry cell values. A minimal WKT → GeoJSON parser (POINT, LINESTRING,
// POLYGON and their MULTI forms, optional Z/M values dropped, optional
// SRID=…; prefix), and `geometryFromValue` for any cell: GeoJSON object or
// text, or WKT. Coordinates are longitude / latitude (WGS84).

import type { Geometry, Position } from 'geojson'
import { geometryKindOf } from '../schema'

type Nested = Position | Nested[]

export function parseWkt(text: string): Geometry | null {
  const s = text.trim().replace(/^SRID=\d+;/i, '')
  const m = /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON)\s*(Z|M|ZM)?\s*(\(.*\)|EMPTY)$/is.exec(s)
  if (!m || /EMPTY/i.test(m[3])) return null
  const kind = m[1].toUpperCase()
  let i = 0
  const body = m[3]

  function parse(): Nested {
    // body[i] is '('
    i++
    const items: Nested[] = []
    let coords = ''
    for (; i < body.length; i++) {
      const c = body[i]
      if (c === '(') items.push(parse())
      else if (c === ')' || c === ',') {
        if (coords.trim()) items.push(coords.trim().split(/\s+/).slice(0, 2).map(Number) as Position)
        coords = ''
        if (c === ')') return items
      } else coords += c
    }
    throw new Error('unbalanced parentheses')
  }

  try {
    const tree = parse() as Nested[]
    const flat = (t: Nested[]): Position[] => t.map((p) => (Array.isArray(p[0]) ? (p as Nested[])[0] : p) as Position)
    switch (kind) {
      case 'POINT':
        return { type: 'Point', coordinates: tree[0] as Position }
      case 'LINESTRING':
        return { type: 'LineString', coordinates: tree as Position[] }
      case 'POLYGON':
        return { type: 'Polygon', coordinates: tree as Position[][] }
      case 'MULTIPOINT': // both "MULTIPOINT (1 2, 3 4)" and "MULTIPOINT ((1 2), (3 4))"
        return { type: 'MultiPoint', coordinates: flat(tree) }
      case 'MULTILINESTRING':
        return { type: 'MultiLineString', coordinates: tree as Position[][] }
      case 'MULTIPOLYGON':
        return { type: 'MultiPolygon', coordinates: tree as Position[][][] }
    }
  } catch {
    return null
  }
  return null
}

/** GeoJSON geometry from a cell: a Geometry/Feature object, GeoJSON text, or WKT. */
export function geometryFromValue(v: unknown): Geometry | null {
  if (v === null || v === undefined) return null
  let o: unknown = v
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return null
    if (!s.startsWith('{')) return parseWkt(s)
    try {
      o = JSON.parse(s)
    } catch {
      return null
    }
  }
  const obj = o as { type?: string; geometry?: Geometry }
  if (obj?.type === 'Feature') return obj.geometry ?? null
  return geometryKindOf(obj as Geometry) ? (obj as Geometry) : null
}

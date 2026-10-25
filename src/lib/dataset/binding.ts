// Geometry bindings: how a table's rows become map features.
//
//   boundary  a column of region codes joined onto built-in polygons
//             (US counties by FIPS; US states by FIPS, abbreviation or name)
//   latlon    latitude + longitude columns → points
//   geometry  a column holding GeoJSON (object or text) or WKT → any geometry
//
// Rows that resolve to the same feature are grouped; aggregation happens later.

import type { Feature, Geometry } from 'geojson'
import type { DataRecord } from '../data/connectors'
import { geometryKindOf, type GeometryKind } from '../schema'
import { STATES } from '../states'
import type { ColumnInfo } from './columns'
import { parseWkt } from './wkt'

export const BOUNDARIES = {
  'us-counties': 'US counties (5-digit FIPS)',
  'us-states': 'US states (FIPS, abbreviation or name)',
} as const
export type BoundaryId = keyof typeof BOUNDARIES

export type GeometryBinding =
  | { kind: 'boundary'; column: string; boundary: BoundaryId; /** Also draw regions with no rows. */ includeEmpty?: boolean }
  | { kind: 'latlon'; lat: string; lon: string }
  | { kind: 'geometry'; column: string }

export interface BoundaryFeature {
  key: string
  name: string
  geometry: Geometry
}

export interface FeatureGroup {
  key: string
  label: string | null
  geometry: Geometry
  rows: DataRecord[]
}

// ── region codes ───────────────────────────────────────────────────────────

/** Retired county codes still found in data → the county that replaced them. */
export const COUNTY_SUCCESSORS: Record<string, string> = {
  '51515': '51019', // Bedford city, VA → Bedford County (2013)
  '46113': '46102', // Shannon County, SD → Oglala Lakota County (2015)
  '02270': '02158', // Wade Hampton, AK → Kusilvak Census Area (2015)
}

const STATE_BY_ABBR = new Map(Object.entries(STATES).map(([fips, s]) => [s.abbr, fips]))
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([fips, s]) => [s.name.toLowerCase(), fips]))

/** Normalize a raw code to the boundary set's key, or null if it can't be one. */
export function boundaryKey(boundary: BoundaryId, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  if (!s) return null
  if (boundary === 'us-counties') {
    const d = s.replace(/\.0+$/, '') // "1001.0" from spreadsheets
    if (!/^\d{1,5}$/.test(d)) return null
    const key = d.padStart(5, '0')
    return COUNTY_SUCCESSORS[key] ?? key
  }
  if (/^\d{1,2}$/.test(s)) return s.padStart(2, '0')
  return STATE_BY_ABBR.get(s.toUpperCase()) ?? STATE_BY_NAME.get(s.toLowerCase()) ?? null
}

// ── geometry values ────────────────────────────────────────────────────────

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

// ── grouping ───────────────────────────────────────────────────────────────

export interface GroupResult {
  groups: FeatureGroup[]
  /** Rows whose geometry couldn't be resolved. */
  unmatched: number
  /** A few raw values that failed, for the log. */
  unmatchedSamples: string[]
}

export function groupRows(records: DataRecord[], binding: GeometryBinding, boundaries?: Map<string, BoundaryFeature>): GroupResult {
  const byKey = new Map<string, FeatureGroup>()
  let unmatched = 0
  const unmatchedSamples: string[] = []
  const miss = (raw: unknown) => {
    unmatched++
    if (unmatchedSamples.length < 8) unmatchedSamples.push(String(raw))
  }

  if (binding.kind === 'boundary') {
    if (!boundaries) throw new Error('boundary polygons not loaded')
    for (const r of records) {
      const raw = r[binding.column]
      const key = boundaryKey(binding.boundary, raw)
      const b = key ? boundaries.get(key) : undefined
      if (!b) {
        miss(raw)
        continue
      }
      let g = byKey.get(b.key)
      if (!g) byKey.set(b.key, (g = { key: b.key, label: b.name, geometry: b.geometry, rows: [] }))
      g.rows.push(r)
    }
    if (binding.includeEmpty) {
      for (const b of boundaries.values()) if (!byKey.has(b.key)) byKey.set(b.key, { key: b.key, label: b.name, geometry: b.geometry, rows: [] })
    }
  } else if (binding.kind === 'latlon') {
    for (const r of records) {
      const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === ''
      const lat = Number(r[binding.lat])
      const lon = Number(r[binding.lon])
      const valid =
        !blank(r[binding.lat]) && !blank(r[binding.lon]) && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      if (!valid) {
        miss(`${r[binding.lat]}, ${r[binding.lon]}`)
        continue
      }
      const key = `${lat.toFixed(6)},${lon.toFixed(6)}`
      let g = byKey.get(key)
      if (!g) byKey.set(key, (g = { key, label: null, geometry: { type: 'Point', coordinates: [lon, lat] }, rows: [] }))
      g.rows.push(r)
    }
  } else {
    // Identical geometries (e.g. the same line listed per owner) share a feature.
    const idByText = new Map<string, string>()
    for (const r of records) {
      const raw = r[binding.column]
      const geom = geometryFromValue(raw)
      if (!geom) {
        miss(typeof raw === 'string' ? raw.slice(0, 40) : JSON.stringify(raw)?.slice(0, 40))
        continue
      }
      const text = JSON.stringify(geom)
      let key = idByText.get(text)
      if (!key) idByText.set(text, (key = `f${idByText.size + 1}`))
      let g = byKey.get(key)
      if (!g) byKey.set(key, (g = { key, label: null, geometry: geom, rows: [] }))
      g.rows.push(r)
    }
  }
  return { groups: [...byKey.values()], unmatched, unmatchedSamples }
}

/** The geometry kind most features have (layers render one kind). */
export function dominantKind(groups: FeatureGroup[]): GeometryKind {
  const counts: Record<GeometryKind, number> = { point: 0, polyline: 0, region: 0 }
  for (const g of groups) {
    const k = geometryKindOf(g.geometry)
    if (k) counts[k]++
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] as GeometryKind) ?? 'region'
}

// ── guessing ───────────────────────────────────────────────────────────────

const COUNTY_COL = /^(county_?fips|fips|geoid|county_?geoid|fips_?code|cnty_?fips|county_?id)$/i
const STATE_COL = /^(state|state_?fips|state_?abbr|state_?code|st|state_?name|statefp)$/i
const LAT_COL = /^(lat|latitude|y|lat_?dd)$/i
const LON_COL = /^(lon|lng|long|longitude|x|lon_?dd)$/i
const GEOM_COL = /^(geometry|geom|the_?geom|wkt|shape|geojson)$/i

/** A best guess at the binding from column names and types; the user can change it. */
export function guessBinding(columns: ColumnInfo[]): GeometryBinding | null {
  const geom = columns.find((c) => c.type === 'geometry') ?? columns.find((c) => GEOM_COL.test(c.name))
  if (geom) return { kind: 'geometry', column: geom.name }
  const lat = columns.find((c) => LAT_COL.test(c.name))
  const lon = columns.find((c) => LON_COL.test(c.name))
  if (lat && lon) return { kind: 'latlon', lat: lat.name, lon: lon.name }
  const county = columns.find((c) => COUNTY_COL.test(c.name))
  if (county) return { kind: 'boundary', column: county.name, boundary: 'us-counties' }
  const state = columns.find((c) => STATE_COL.test(c.name))
  if (state) return { kind: 'boundary', column: state.name, boundary: 'us-states' }
  return null
}

/** Columns a binding consumes (not offered as data to visualize). */
export function bindingColumns(b: GeometryBinding): string[] {
  return b.kind === 'latlon' ? [b.lat, b.lon] : [b.column]
}

/** Polygons from TopoJSON features with ids, keyed for a boundary set. */
export function boundaryIndex(boundary: BoundaryId, features: Feature<Geometry, { name?: string }>[]): Map<string, BoundaryFeature> {
  const out = new Map<string, BoundaryFeature>()
  for (const f of features) {
    const key = boundary === 'us-counties' ? String(f.id).padStart(5, '0') : String(f.id).padStart(2, '0')
    const st = STATES[key.slice(0, 2)]
    const name = boundary === 'us-counties' ? `${f.properties?.name ?? key}${st ? `, ${st.abbr}` : ''}` : (st?.name ?? f.properties?.name ?? key)
    out.set(key, { key, name, geometry: f.geometry })
  }
  return out
}

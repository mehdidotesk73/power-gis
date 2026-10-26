// Geometry bindings: which column gives each row its map feature.
//
//   geometry  a geometry column (point / polyline / region, lon/lat) → that feature
//   boundary  a column of region codes joined onto built-in polygons
//             (US counties by FIPS; US states by FIPS, abbreviation or name).
//             A stopgap until transforms can join a boundary dataset instead.
//
// Rows with the same feature are grouped; aggregation happens later.

import type { Feature, Geometry } from 'geojson'
import type { DataRecord } from '../data/connectors'
import { geometryKindOf, type GeometryKind } from '../schema'
import { STATES } from '../states'
import { isGeometryColumn, type ColumnInfo } from './columns'
import { geometryFromValue } from './wkt'

export { geometryFromValue }

export const BOUNDARIES = {
  'us-counties': 'US counties (5-digit FIPS)',
  'us-states': 'US states (FIPS, abbreviation or name)',
} as const
export type BoundaryId = keyof typeof BOUNDARIES

export type GeometryBinding =
  | { kind: 'boundary'; column: string; boundary: BoundaryId; /** Also draw regions with no rows. */ includeEmpty?: boolean }
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

/** A best guess at the binding: a geometry column (regions first), else region codes. */
export function guessBinding(columns: ColumnInfo[]): GeometryBinding | null {
  const geom = ['region', 'polyline', 'point'].map((t) => columns.find((c) => c.type === t)).find(Boolean)
  if (geom) return { kind: 'geometry', column: geom.name }
  const county = columns.find((c) => COUNTY_COL.test(c.name))
  if (county) return { kind: 'boundary', column: county.name, boundary: 'us-counties' }
  const state = columns.find((c) => STATE_COL.test(c.name))
  if (state) return { kind: 'boundary', column: state.name, boundary: 'us-states' }
  return null
}

/** Columns a binding consumes (not offered as data to visualize). */
export function bindingColumns(b: GeometryBinding): string[] {
  return [b.column]
}

/** Whether a saved binding is one this version understands (older ones had lat/lon pairs). */
export function isSupportedBinding(b: { kind?: string; column?: unknown } | undefined): b is GeometryBinding {
  return (b?.kind === 'geometry' || b?.kind === 'boundary') && typeof b.column === 'string'
}

/** Geometry columns of a table: what a geometry binding can use. */
export const geometryColumns = (columns: ColumnInfo[]) => columns.filter((c) => isGeometryColumn(c.type))

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

// Geometry bindings: which geometry column (point / polyline / region,
// lon/lat) gives each row its map feature, and optionally which column names
// the feature. Region codes (county FIPS, state names…) aren't a binding:
// join a boundary dataset onto them in a transform and draw its geometry.
//
// Rows with the same geometry are grouped onto one feature; aggregation
// happens later.

import type { Geometry } from 'geojson'
import type { DataRecord } from '../data/connectors'
import { geometryKindOf, type GeometryKind } from '../schema'
import { isGeometryColumn, type ColumnInfo } from './columns'
import { geometryFromValue } from './wkt'

export { geometryFromValue }

export interface GeometryBinding {
  kind: 'geometry'
  column: string
  /** Column whose value names each feature (tooltips, Find); absent → unnamed. */
  label?: string
}

export interface FeatureGroup {
  key: string
  label: string | null
  geometry: Geometry
  rows: DataRecord[]
}

// ── grouping ───────────────────────────────────────────────────────────────

export interface GroupResult {
  groups: FeatureGroup[]
  /** Rows whose geometry couldn't be resolved. */
  unmatched: number
  /** A few raw values that failed, for the log. */
  unmatchedSamples: string[]
}

export function groupRows(records: DataRecord[], binding: GeometryBinding): GroupResult {
  const byKey = new Map<string, FeatureGroup>()
  let unmatched = 0
  const unmatchedSamples: string[] = []
  // Identical geometries (a county listed once per utility, a line per owner)
  // share a feature. Rows often share the very same object, so its key is
  // remembered by identity before falling back to comparing the text.
  const idByText = new Map<string, string>()
  const idByObject = new WeakMap<object, string>()
  for (const r of records) {
    const raw = r[binding.column]
    const geom = geometryFromValue(raw)
    if (!geom) {
      unmatched++
      if (unmatchedSamples.length < 8) unmatchedSamples.push(typeof raw === 'string' ? raw.slice(0, 40) : String(JSON.stringify(raw)).slice(0, 40))
      continue
    }
    let key = idByObject.get(geom)
    if (!key) {
      const text = JSON.stringify(geom)
      key = idByText.get(text)
      if (!key) idByText.set(text, (key = `f${idByText.size + 1}`))
      idByObject.set(geom, key)
    }
    let g = byKey.get(key)
    if (!g) byKey.set(key, (g = { key, label: null, geometry: geom, rows: [] }))
    g.rows.push(r)
    if (g.label === null && binding.label) {
      const l = r[binding.label]
      if (l !== null && l !== undefined && l !== '') g.label = String(l)
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

const LABEL_COL = [/^name$/i, /^(label|title)$/i, /_name$|^name_/i, /^(county|state|city|place|region|area)$/i]

/** A column that likely names features: text, preferring "name", then other name-ish columns. */
export function guessLabel(columns: ColumnInfo[]): string | undefined {
  const text = columns.filter((c) => c.type === 'string')
  for (const re of LABEL_COL) {
    const c = text.find((x) => re.test(x.name))
    if (c) return c.name
  }
  return undefined
}

/** A best guess at the binding: a geometry column (regions first) and a label column. */
export function guessBinding(columns: ColumnInfo[]): GeometryBinding | null {
  const geom = ['region', 'polyline', 'point'].map((t) => columns.find((c) => c.type === t)).find(Boolean)
  if (!geom) return null
  const label = guessLabel(columns)
  return { kind: 'geometry', column: geom.name, ...(label ? { label } : {}) }
}

/** Columns a binding consumes (not offered as data to visualize). */
export function bindingColumns(b: GeometryBinding): string[] {
  return [b.column]
}

/** Whether a saved binding is one this version understands (older ones had lat/lon pairs or region codes). */
export function isSupportedBinding(b: { kind?: string; column?: unknown } | undefined): b is GeometryBinding {
  return b?.kind === 'geometry' && typeof b.column === 'string'
}

/** Geometry columns of a table: what a geometry binding can use. */
export const geometryColumns = (columns: ColumnInfo[]) => columns.filter((c) => isGeometryColumn(c.type))

// Server-side computation for visualizations: group a dataset's rows onto
// features under a geometry binding, then aggregate one column per feature.
// Pure functions; the server caches the grouping per (dataset, binding) so
// several visualizations of the same table reuse it.

import type { Geometry } from 'geojson'
import type { DataRecord } from '../data/connectors'
import { geometryKindOf, type GeometryKind } from '../schema'
import { aggregate, type Aggregation } from './aggregate'
import { dominantKind, groupRows, type BoundaryFeature, type FeatureGroup, type GeometryBinding } from './binding'
import { coerce, type ColumnInfo, type ColumnType } from './columns'
import { dataColumns, ROWS, valueType, type DatasetShape } from './visualization'

export interface Grouped {
  groups: FeatureGroup[]
  geometryKind: GeometryKind
  maxRowsPerFeature: number
  matchedRows: number
  unmatched: number
  unmatchedSamples: string[]
}

/** Coerce rows to their column types and group them onto features (one geometry kind). */
export function groupDataset(records: DataRecord[], columns: ColumnInfo[], binding: GeometryBinding, boundaries?: Map<string, BoundaryFeature>): Grouped {
  const rows = records.map((r) => {
    const o: DataRecord = {}
    for (const c of columns) o[c.name] = coerce(r[c.name], c.type)
    return o
  })
  const { groups: all, unmatched, unmatchedSamples } = groupRows(rows, binding, boundaries)
  const geometryKind = dominantKind(all.filter((g) => g.rows.length))
  const groups = all.filter((g) => geometryKindOf(g.geometry) === geometryKind)
  return {
    groups,
    geometryKind,
    maxRowsPerFeature: groups.reduce((m, g) => Math.max(m, g.rows.length), 0),
    matchedRows: records.length - unmatched,
    unmatched,
    unmatchedSamples,
  }
}

/** How a dataset looks under a binding — for defaults and the binding preview. */
export interface BindingInfo extends DatasetShape {
  /** Features that have rows. */
  features: number
  matchedRows: number
  unmatched: number
  unmatchedSamples: string[]
}

export function bindingInfo(g: Grouped, columns: ColumnInfo[], binding: GeometryBinding): BindingInfo {
  return {
    columns: dataColumns(columns, binding),
    maxRowsPerFeature: g.maxRowsPerFeature,
    geometryKind: g.geometryKind,
    features: g.groups.filter((x) => x.rows.length).length,
    matchedRows: g.matchedRows,
    unmatched: g.unmatched,
    unmatchedSamples: g.unmatchedSamples,
  }
}

export interface VizFeature {
  key: string
  label: string
  rows: number
  value: unknown
  /** Absent for region-code bindings: the client has the polygons. */
  geometry?: Geometry
}

/** One value per feature: what the server returns for a visualization. */
export interface VizValues {
  geometryKind: GeometryKind
  valueType: ColumnType
  features: VizFeature[]
  unmatched: number
  unmatchedSamples: string[]
}

export function queryValues(g: Grouped, columns: ColumnInfo[], column: string, aggregation: Aggregation, withGeometry: boolean): VizValues {
  return {
    geometryKind: g.geometryKind,
    valueType: valueType(columns, column, aggregation),
    features: g.groups.map((x) => ({
      key: x.key,
      label: x.label ?? x.key,
      rows: x.rows.length,
      value: column === ROWS ? x.rows.length : aggregate(x.rows.map((r) => r[column]), aggregation),
      ...(withGeometry ? { geometry: x.geometry } : {}),
    })),
    unmatched: g.unmatched,
    unmatchedSamples: g.unmatchedSamples,
  }
}

// ── find: which features have a value ──────────────────────────────────────

/** A searchable value: a feature's label, or a text cell in the rows behind features. */
export interface FindEntry {
  /** The column it's from, or LABEL_COLUMN for feature names. */
  column: string
  value: string
  /** How many features have it. */
  features: number
}
export const LABEL_COLUMN = '_label'

/** Columns with more distinct values than this are left out of the index (ids, free text). */
const MAX_DISTINCT = 20_000

export interface FindIndex {
  entries: FindEntry[]
  /** `${column}\u0000${value}` → feature keys. */
  keys: Map<string, string[]>
}

/** Every distinct text value (and feature label) with the features it appears on. */
export function findIndex(g: Grouped, columns: ColumnInfo[]): FindIndex {
  const sets = new Map<string, Set<string>>()
  const add = (column: string, value: string, key: string) => {
    const id = `${column}\u0000${value}`
    let s = sets.get(id)
    if (!s) sets.set(id, (s = new Set()))
    s.add(key)
  }
  const text = columns.filter((c) => c.type === 'string')
  const distinct = new Map<string, Set<string>>(text.map((c) => [c.name, new Set()]))
  for (const grp of g.groups) {
    if (!grp.rows.length) continue
    if (grp.label) add(LABEL_COLUMN, grp.label, grp.key)
    for (const r of grp.rows)
      for (const c of text) {
        const v = r[c.name]
        if (v === null || v === undefined || v === '') continue
        const d = distinct.get(c.name)!
        if (d.size > MAX_DISTINCT) continue
        d.add(String(v))
        add(c.name, String(v), grp.key)
      }
  }
  const tooMany = new Set([...distinct].filter(([, d]) => d.size > MAX_DISTINCT).map(([n]) => n))
  const entries: FindEntry[] = []
  const keys = new Map<string, string[]>()
  for (const [id, s] of sets) {
    const [column, value] = id.split('\u0000')
    if (tooMany.has(column)) continue
    entries.push({ column, value, features: s.size })
    keys.set(id, [...s])
  }
  return { entries, keys }
}

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

// A data source is one imported table plus a geometry binding — the data.
// Building it groups the rows onto map features (one per region / point /
// shape) with every column aggregated by default. Layers (layer.ts) then
// visualize its columns. Pure functions: rows in, features out.

import type { DataRecord } from '../data/connectors'
import type { FieldDef, FieldType, GeometryKind, LayerData, LayerFeature } from '../schema'
import { geometryKindOf } from '../schema'
import { aggregate, aggregatedType, defaultAggregation } from './aggregate'
import { bindingColumns, dominantKind, groupRows, type BoundaryFeature, type GeometryBinding } from './binding'
import { coerce, type ColumnInfo, type ColumnType } from './columns'

// Synthetic properties on every data source feature.
export const KEY = '_key'
export const LABEL = '_label'
export const ROW_COUNT = '_rows'

export interface DatasourceSpec {
  id: string
  name: string
  binding: GeometryBinding
  /** Where the rows came from, for display. */
  origin: string
}

export interface BuiltDatasource {
  /** One feature per resolved geometry, with every data column aggregated by default. */
  base: LayerData
  /** Data columns (binding columns excluded), typed. */
  columns: ColumnInfo[]
  /** Coerced rows behind each feature, for panels and layer aggregation. */
  rowsByKey: Map<string, DataRecord[]>
  maxRowsPerFeature: number
  geometryKind: GeometryKind
  unmatched: number
  unmatchedSamples: string[]
}

let counter = 0
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

export function fieldTypeOf(t: ColumnType): FieldType {
  return t === 'geometry' ? 'string' : t
}

/**
 * Add a vector column built from two numeric columns (east, north), for
 * tables that store vectors as separate u/v columns.
 */
export function withVectorColumn(records: DataRecord[], name: string, u: string, v: string): DataRecord[] {
  return records.map((r) => {
    const uu = Number(r[u])
    const vv = Number(r[v])
    const ok = r[u] !== null && r[u] !== '' && r[v] !== null && r[v] !== '' && Number.isFinite(uu) && Number.isFinite(vv)
    return { ...r, [name]: ok ? { u: uu, v: vv } : null }
  })
}

export function buildDatasource(
  meta: { id: string; name: string; binding: GeometryBinding; origin?: string },
  records: DataRecord[],
  allColumns: ColumnInfo[],
  boundaries?: Map<string, BoundaryFeature>,
): BuiltDatasource {
  const skip = new Set(bindingColumns(meta.binding))
  const columns = allColumns.filter((c) => !skip.has(c.name) && c.type !== 'geometry')
  const rows = records.map((r) => {
    const o: DataRecord = {}
    for (const c of allColumns) o[c.name] = coerce(r[c.name], c.type)
    return o
  })
  const { groups, unmatched, unmatchedSamples } = groupRows(rows, meta.binding, boundaries)
  const geometryKind = dominantKind(groups)
  const maxRowsPerFeature = groups.reduce((m, g) => Math.max(m, g.rows.length), 0)

  const rowsByKey = new Map<string, DataRecord[]>()
  const features: LayerFeature[] = []
  for (const g of groups) {
    if (geometryKindOf(g.geometry) !== geometryKind) continue // one geometry kind per data source
    rowsByKey.set(g.key, g.rows)
    const props: Record<string, unknown> = { [KEY]: g.key, [LABEL]: g.label ?? g.key, [ROW_COUNT]: g.rows.length }
    for (const c of columns) props[c.name] = aggregate(g.rows.map((r) => r[c.name]), defaultAggregation(c.type, maxRowsPerFeature))
    features.push({ type: 'Feature', id: g.key, geometry: g.geometry, properties: props })
  }

  const fields: FieldDef[] = [
    { name: LABEL, type: 'string', alias: 'Name' },
    { name: ROW_COUNT, type: 'int', alias: 'Rows' },
    ...columns.map((c) => ({
      name: c.name,
      type: fieldTypeOf(aggregatedType(defaultAggregation(c.type, maxRowsPerFeature), c.type)),
      alias: c.name.replace(/_/g, ' '),
    })),
  ]
  return {
    base: {
      id: meta.id,
      name: meta.name,
      geometry: geometryKind,
      idField: KEY,
      titleField: LABEL,
      fields,
      features,
      source: meta.origin ? { label: meta.origin } : undefined,
    },
    columns,
    rowsByKey,
    maxRowsPerFeature,
    geometryKind,
    unmatched,
    unmatchedSamples,
  }
}

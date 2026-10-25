// A source layer ("super layer") is one table + a geometry binding. Each of
// its sublayers visualizes one column (or two, for vectors), aggregated per
// feature, with its own style and visibility. Pure functions: rows in,
// LayerData out — the map widgets render the result.

import type { DataRecord } from '../data/source'
import type { FieldDef, FieldType, GeometryKind, LayerData, LayerFeature } from '../schema'
import type { ScalarStyle, VectorStyle } from '../style'
import { aggregate, aggregatedType, defaultAggregation, type Aggregation } from './aggregate'
import { bindingColumns, dominantKind, groupRows, type BoundaryFeature, type GeometryBinding } from './binding'
import { coerce, isNumericColumn, type ColumnInfo, type ColumnType } from './columns'
import { geometryKindOf } from '../schema'

/** Pseudo-column: the number of rows on each feature. */
export const ROWS = '__rows'

// Synthetic properties on every built feature.
export const KEY = '_key'
export const LABEL = '_label'
export const ROW_COUNT = '_rows'
export const VALUE = '_value'
export const U = '_u'
export const V = '_v'

interface SublayerBase {
  id: string
  name: string
  visible: boolean
  aggregation: Aggregation
}
export interface ScalarSublayer extends SublayerBase {
  kind: 'scalar'
  column: string
  style: ScalarStyle
}
export interface VectorSublayer extends SublayerBase {
  kind: 'vector'
  /** East and north components. */
  u: string
  v: string
  style: VectorStyle
}
export type SublayerSpec = ScalarSublayer | VectorSublayer

export interface SourceLayerSpec {
  id: string
  name: string
  binding: GeometryBinding
  sublayers: SublayerSpec[]
  visible: boolean
}

export interface BuiltSource {
  /** One feature per resolved geometry, with every data column aggregated by default. */
  base: LayerData
  /** Data columns (binding columns excluded), typed. */
  columns: ColumnInfo[]
  /** Coerced rows behind each feature, for panels. */
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

export function columnLabel(column: string): string {
  return column === ROWS ? 'Number of rows' : column.replace(/_/g, ' ')
}

export function buildSource(
  meta: { id: string; name: string; binding: GeometryBinding; source?: LayerData['source'] },
  records: DataRecord[],
  allColumns: ColumnInfo[],
  boundaries?: Map<string, BoundaryFeature>,
): BuiltSource {
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
    if (geometryKindOf(g.geometry) !== geometryKind) continue // one geometry kind per layer
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
      alias: columnLabel(c.name),
    })),
  ]
  return {
    base: { id: meta.id, name: meta.name, geometry: geometryKind, idField: KEY, titleField: LABEL, fields, features, source: meta.source },
    columns,
    rowsByKey,
    maxRowsPerFeature,
    geometryKind,
    unmatched,
    unmatchedSamples,
  }
}

/** Type of a sublayer column's aggregated value. */
export function valueType(built: BuiltSource, column: string, agg: Aggregation): ColumnType {
  if (column === ROWS) return 'int'
  const c = built.columns.find((x) => x.name === column)
  return aggregatedType(agg, c?.type ?? 'string')
}

function reduce(built: BuiltSource, key: string, column: string, agg: Aggregation): unknown {
  const rows = built.rowsByKey.get(key) ?? []
  if (column === ROWS) return rows.length
  return aggregate(rows.map((r) => r[column]), agg)
}

/** The renderable layer for one sublayer: base features plus its aggregated value(s). */
export function sublayerData(built: BuiltSource, spec: SourceLayerSpec, sub: SublayerSpec): LayerData {
  const features = built.base.features.map((f) => {
    const key = String(f.properties[KEY])
    const extra =
      sub.kind === 'scalar'
        ? { [VALUE]: reduce(built, key, sub.column, sub.aggregation) }
        : { [U]: reduce(built, key, sub.u, sub.aggregation), [V]: reduce(built, key, sub.v, sub.aggregation) }
    return { ...f, properties: { ...f.properties, ...extra } }
  })
  const valueFields: FieldDef[] =
    sub.kind === 'scalar'
      ? [{ name: VALUE, type: fieldTypeOf(valueType(built, sub.column, sub.aggregation)), alias: sub.name }]
      : [
          { name: U, type: 'double', alias: `${columnLabel(sub.u)} (east)` },
          { name: V, type: 'double', alias: `${columnLabel(sub.v)} (north)` },
        ]
  return {
    ...built.base,
    id: `${spec.id}__${sub.id}`,
    name: `${spec.name} · ${sub.name}`,
    fields: [...valueFields, ...built.base.fields],
    features,
  }
}

// ── defaults ───────────────────────────────────────────────────────────────

const OUTLINE = { color: '#ffffff', width: 0.3, opacity: 0.7 }

/** A style suited to a value type: colormap for numbers, categories otherwise. */
export function defaultScalarStyle(type: ColumnType, geometry: GeometryKind, field = VALUE): ScalarStyle {
  const base = { opacity: { kind: 'constant' as const, value: 0.75 }, pattern: { kind: 'none' as const }, outline: OUTLINE, size: geometry === 'point' ? 5 : 2 }
  if (isNumericColumn(type)) return { ...base, color: { kind: 'colormap', field, colormap: 'viridis' } }
  if (type === 'string' || type === 'boolean') return { ...base, color: { kind: 'categorical', field } }
  return { ...base, color: { kind: 'constant', color: '#3b82f6' } }
}

export const defaultVectorStyle = (): VectorStyle => ({
  components: { kind: 'uv', u: U, v: V },
  color: { kind: 'colormap', field: '_magnitude', colormap: 'plasma' },
  opacity: { kind: 'constant', value: 0.9 },
  size: { min: 0.5, max: 1.4 },
})

export function makeScalarSublayer(built: BuiltSource, column: string, aggregation?: Aggregation, name?: string): ScalarSublayer {
  const col = built.columns.find((c) => c.name === column)
  const agg = aggregation ?? (column === ROWS ? 'count' : defaultAggregation(col?.type ?? 'string', built.maxRowsPerFeature))
  return {
    id: newId('s'),
    name: name ?? columnLabel(column),
    visible: true,
    kind: 'scalar',
    column,
    aggregation: agg,
    style: defaultScalarStyle(valueType(built, column, agg), built.geometryKind),
  }
}

export function makeVectorSublayer(built: BuiltSource, u: string, v: string, name?: string): VectorSublayer {
  return {
    id: newId('v'),
    name: name ?? `${columnLabel(u)} / ${columnLabel(v)}`,
    visible: true,
    kind: 'vector',
    u,
    v,
    aggregation: built.maxRowsPerFeature > 1 ? 'mean' : 'first',
    style: defaultVectorStyle(),
  }
}

/** First sublayer for a new source: row counts when rows stack up, else the first numeric/text column. */
export function defaultSublayer(built: BuiltSource): ScalarSublayer {
  if (built.maxRowsPerFeature > 1) return makeScalarSublayer(built, ROWS)
  const pick = built.columns.find((c) => isNumericColumn(c.type)) ?? built.columns.find((c) => c.type === 'string' || c.type === 'boolean')
  if (pick) return makeScalarSublayer(built, pick.name)
  const s = makeScalarSublayer(built, ROWS, 'count', 'Features')
  s.style.color = { kind: 'constant', color: '#3b82f6' }
  return s
}

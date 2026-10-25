// A layer is one visualization of one data source column, aggregated per
// feature. The column's type decides the visualization: vector columns are
// drawn as arrows, every other column as a scalar (color / transparency /
// pattern). A data source can have any number of layers, and layers from
// different data sources show together.

import type { FieldDef, LayerData } from '../schema'
import type { ScalarStyle, VectorStyle } from '../style'
import { aggregate, aggregatedType, defaultAggregation, type Aggregation } from './aggregate'
import { isNumericColumn, type ColumnType } from './columns'
import { fieldTypeOf, KEY, newId, type BuiltDatasource } from './datasource'
import type { GeometryKind } from '../schema'

/** Pseudo-column: the number of rows on each feature. */
export const ROWS = '__rows'
/** Property holding the layer's aggregated value on each feature. */
export const VALUE = '_value'

interface LayerBase {
  id: string
  datasourceId: string
  name: string
  visible: boolean
  column: string
  aggregation: Aggregation
}
export interface ScalarLayerSpec extends LayerBase {
  kind: 'scalar'
  style: ScalarStyle
}
export interface VectorLayerSpec extends LayerBase {
  kind: 'vector'
  style: VectorStyle
}
export type LayerSpec = ScalarLayerSpec | VectorLayerSpec

export function columnLabel(column: string): string {
  return column === ROWS ? 'Number of rows' : column.replace(/_/g, ' ')
}

export function columnType(built: BuiltDatasource, column: string): ColumnType {
  return column === ROWS ? 'int' : (built.columns.find((c) => c.name === column)?.type ?? 'string')
}

/** Type of a layer's aggregated value. */
export function valueType(built: BuiltDatasource, column: string, agg: Aggregation): ColumnType {
  return column === ROWS ? 'int' : aggregatedType(agg, columnType(built, column))
}

/** Arrows for vector values, scalar otherwise. */
export function kindFor(built: BuiltDatasource, column: string, agg: Aggregation): LayerSpec['kind'] {
  return valueType(built, column, agg) === 'vector' ? 'vector' : 'scalar'
}

/** The renderable data for one layer: the data source's features plus the layer's value. */
export function layerData(built: BuiltDatasource, datasourceName: string, layer: LayerSpec): LayerData {
  const features = built.base.features.map((f) => {
    const rows = built.rowsByKey.get(String(f.properties[KEY])) ?? []
    const value = layer.column === ROWS ? rows.length : aggregate(rows.map((r) => r[layer.column]), layer.aggregation)
    return { ...f, properties: { ...f.properties, [VALUE]: value } }
  })
  const valueField: FieldDef = { name: VALUE, type: fieldTypeOf(valueType(built, layer.column, layer.aggregation)), alias: layer.name }
  return {
    ...built.base,
    id: layer.id,
    name: `${datasourceName} · ${layer.name}`,
    fields: [valueField, ...built.base.fields],
    features,
  }
}

// ── defaults ───────────────────────────────────────────────────────────────

const OUTLINE = { color: '#ffffff', width: 0.3, opacity: 0.7 }

/** A scalar style suited to a value type: colormap for numbers, categories otherwise. */
export function defaultScalarStyle(type: ColumnType, geometry: GeometryKind, field = VALUE): ScalarStyle {
  const base = { opacity: { kind: 'constant' as const, value: 0.75 }, pattern: { kind: 'none' as const }, outline: OUTLINE, size: geometry === 'point' ? 5 : 2 }
  if (isNumericColumn(type)) return { ...base, color: { kind: 'colormap', field, colormap: 'viridis' } }
  if (type === 'string' || type === 'boolean') return { ...base, color: { kind: 'categorical', field } }
  return { ...base, color: { kind: 'constant', color: '#3b82f6' } }
}

export const defaultVectorStyle = (): VectorStyle => ({
  components: { kind: 'vector', field: VALUE },
  color: { kind: 'colormap', field: '_magnitude', colormap: 'plasma' },
  opacity: { kind: 'constant', value: 0.9 },
  size: { min: 0.5, max: 1.4 },
})

/** A layer showing `column`; its kind (scalar / vector) follows the column's type. */
export function makeLayer(built: BuiltDatasource, datasourceId: string, column: string, aggregation?: Aggregation, name?: string): LayerSpec {
  const agg = aggregation ?? (column === ROWS ? 'count' : defaultAggregation(columnType(built, column), built.maxRowsPerFeature))
  const base = { id: newId('l'), datasourceId, name: name ?? columnLabel(column), visible: true, column, aggregation: agg }
  return kindFor(built, column, agg) === 'vector'
    ? { ...base, kind: 'vector', style: defaultVectorStyle() }
    : { ...base, kind: 'scalar', style: defaultScalarStyle(valueType(built, column, agg), built.geometryKind) }
}

/** First layer for a new data source: row counts when rows stack up, else a vector, numeric or text column. */
export function defaultLayer(built: BuiltDatasource, datasourceId: string): LayerSpec {
  if (built.maxRowsPerFeature > 1) return makeLayer(built, datasourceId, ROWS)
  const pick =
    built.columns.find((c) => c.type === 'vector') ??
    built.columns.find((c) => isNumericColumn(c.type)) ??
    built.columns.find((c) => c.type === 'string' || c.type === 'boolean')
  if (pick) return makeLayer(built, datasourceId, pick.name)
  const l = makeLayer(built, datasourceId, ROWS, 'count', 'Features') as ScalarLayerSpec
  l.style.color = { kind: 'constant', color: '#3b82f6' }
  return l
}

/**
 * Point a layer at a different column/aggregation. Keeps its style when the
 * kind of value is unchanged; otherwise switches to a default for the new kind.
 */
export function retarget(built: BuiltDatasource, layer: LayerSpec, column: string, aggregation: Aggregation): LayerSpec {
  const next = makeLayer(built, layer.datasourceId, column, aggregation)
  const sameKind = next.kind === layer.kind
  const sameScale =
    sameKind && (layer.kind === 'vector' || isNumericColumn(valueType(built, layer.column, layer.aggregation)) === isNumericColumn(valueType(built, column, aggregation)))
  const autoName = layer.name === columnLabel(layer.column)
  return {
    ...next,
    id: layer.id,
    visible: layer.visible,
    name: autoName ? next.name : layer.name,
    ...(sameScale ? { style: layer.style } : {}),
  } as LayerSpec
}

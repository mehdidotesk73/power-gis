// A visualization draws one dataset column on map features. Its settings say
// where each row's feature comes from (the geometry binding), which column,
// how rows on the same feature combine (aggregation), and the style. The
// value type decides how it draws: vectors as arrows, everything else as a
// scalar (color / transparency / pattern). Values are computed server side
// (query.ts); this module holds the settings and their defaults.

import type { FieldDef, GeometryKind, LayerData, LayerFeature } from '../schema'
import type { ScalarStyle, VectorStyle } from '../style'
import { aggregatedType, defaultAggregation, type Aggregation } from './aggregate'
import { bindingColumns, type GeometryBinding } from './binding'
import { isGeometryColumn, isNumericColumn, type ColumnInfo, type ColumnType } from './columns'
import { fieldTypeOf, guessLatLon, KEY, LABEL, newId, ROW_COUNT } from './dataset'
import type { VizValues } from './query'

/** Pseudo-column: the number of rows on each feature. */
export const ROWS = '__rows'
/** Property holding the visualization's value on each feature. */
export const VALUE = '_value'

interface Settings<K, S> {
  kind: K
  visible: boolean
  binding: GeometryBinding
  column: string
  aggregation: Aggregation
  style: S
}
/** What the visualizations table stores beside the dataset pointer. */
export type VisualizationSettings = Settings<'scalar', ScalarStyle> | Settings<'vector', VectorStyle>
export type VisualizationSpec = VisualizationSettings & { id: string; datasetId: string; name: string }
export type ScalarVisualizationSpec = Extract<VisualizationSpec, { kind: 'scalar' }>
export type VectorVisualizationSpec = Extract<VisualizationSpec, { kind: 'vector' }>

export const settingsOf = ({ id: _id, datasetId: _d, name: _n, ...s }: VisualizationSpec): VisualizationSettings => s as VisualizationSettings

/** What a dataset looks like under a binding: enough to pick defaults. */
export interface DatasetShape {
  /** Data columns (binding and geometry columns excluded). */
  columns: ColumnInfo[]
  maxRowsPerFeature: number
  geometryKind: GeometryKind
}

/** A dataset's columns that can be visualized under a binding. */
export function dataColumns(columns: ColumnInfo[], binding: GeometryBinding): ColumnInfo[] {
  const skip = new Set(bindingColumns(binding))
  return columns.filter((c) => !skip.has(c.name) && !isGeometryColumn(c.type))
}

export function columnLabel(column: string): string {
  return column === ROWS ? 'Number of rows' : column.replace(/_/g, ' ')
}

export function columnType(columns: ColumnInfo[], column: string): ColumnType {
  return column === ROWS ? 'int' : (columns.find((c) => c.name === column)?.type ?? 'string')
}

/** Type of a visualization's aggregated value. */
export function valueType(columns: ColumnInfo[], column: string, agg: Aggregation): ColumnType {
  return column === ROWS ? 'int' : aggregatedType(agg, columnType(columns, column))
}

/** Arrows for vector values, scalar otherwise. */
export function kindFor(columns: ColumnInfo[], column: string, agg: Aggregation): VisualizationSpec['kind'] {
  return valueType(columns, column, agg) === 'vector' ? 'vector' : 'scalar'
}

/** The renderable layer for one visualization from its server-computed values. */
export function visualizationLayer(values: VizValues, spec: VisualizationSpec, datasetName: string): LayerData {
  const features: LayerFeature[] = values.features.map((f) => ({
    type: 'Feature',
    id: f.key,
    geometry: f.geometry,
    properties: { [KEY]: f.key, [LABEL]: f.label, [ROW_COUNT]: f.rows, [VALUE]: f.value },
  }))
  const fields: FieldDef[] = [
    { name: VALUE, type: fieldTypeOf(values.valueType), alias: spec.name },
    { name: LABEL, type: 'string', alias: 'Name' },
    { name: ROW_COUNT, type: 'int', alias: 'Rows' },
  ]
  return { id: spec.id, name: `${datasetName} · ${spec.name}`, geometry: values.geometryKind, idField: KEY, titleField: LABEL, fields, features }
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

/** A visualization showing `column`; its kind (scalar / vector) follows the column's type. */
export function makeVisualization(
  shape: DatasetShape,
  datasetId: string,
  binding: GeometryBinding,
  column: string,
  aggregation?: Aggregation,
  name?: string,
): VisualizationSpec {
  const agg = aggregation ?? (column === ROWS ? 'count' : defaultAggregation(columnType(shape.columns, column), shape.maxRowsPerFeature))
  const base = { id: newId(), datasetId, name: name ?? columnLabel(column), visible: true, binding, column, aggregation: agg }
  return kindFor(shape.columns, column, agg) === 'vector'
    ? { ...base, kind: 'vector', style: defaultVectorStyle() }
    : { ...base, kind: 'scalar', style: defaultScalarStyle(valueType(shape.columns, column, agg), shape.geometryKind) }
}

/** First visualization for a new dataset: row counts when rows stack up, else a vector, numeric or text column. */
export function defaultVisualization(shape: DatasetShape, datasetId: string, binding: GeometryBinding): VisualizationSpec {
  if (shape.maxRowsPerFeature > 1) return makeVisualization(shape, datasetId, binding, ROWS)
  const ll = guessLatLon(shape.columns)
  const coords = new Set(ll ? [ll.lat, ll.lon] : []) // where a row is, not what to show
  const pick =
    shape.columns.find((c) => c.type === 'vector') ??
    shape.columns.find((c) => isNumericColumn(c.type) && !coords.has(c.name)) ??
    shape.columns.find((c) => c.type === 'string' || c.type === 'boolean')
  if (pick) return makeVisualization(shape, datasetId, binding, pick.name)
  const l = makeVisualization(shape, datasetId, binding, ROWS, 'count', 'Features') as ScalarVisualizationSpec
  l.style.color = { kind: 'constant', color: '#3b82f6' }
  return l
}

/**
 * Point a visualization at a different column/aggregation (or binding). Keeps
 * its style when the kind of value is unchanged; otherwise switches to a
 * default for the new kind.
 */
export function retarget(shape: DatasetShape, layer: VisualizationSpec, column: string, aggregation: Aggregation, binding = layer.binding): VisualizationSpec {
  const next = makeVisualization(shape, layer.datasetId, binding, column, aggregation)
  const sameKind = next.kind === layer.kind
  const sameScale =
    sameKind &&
    (layer.kind === 'vector' ||
      isNumericColumn(valueType(shape.columns, layer.column, layer.aggregation)) === isNumericColumn(valueType(shape.columns, column, aggregation)))
  const autoName = layer.name === columnLabel(layer.column)
  return {
    ...next,
    id: layer.id,
    visible: layer.visible,
    name: autoName ? next.name : layer.name,
    ...(sameScale ? { style: layer.style } : {}),
  } as VisualizationSpec
}

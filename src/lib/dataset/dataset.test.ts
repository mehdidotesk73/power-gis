import { describe, expect, it } from 'vitest'
import { aggregate, defaultAggregation } from './aggregate'
import { boundaryKey, geometryFromValue, groupRows, guessBinding, isSupportedBinding, type BoundaryFeature } from './binding'
import { coerce, inferColumns, type ColumnType } from './columns'
import { parseWkt } from './wkt'
import { guessLatLon, withPointColumn, withVectorColumn } from './dataset'
import { bindingInfo, groupDataset, queryValues } from './query'
import { defaultVisualization, makeVisualization, retarget, visualizationLayer, ROWS, VALUE } from './visualization'
import { parseVector } from '../schema'

const square = (x: number) => ({ type: 'Polygon' as const, coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] })
const counties = new Map<string, BoundaryFeature>([
  ['01001', { key: '01001', name: 'Autauga, AL', geometry: square(0) }],
  ['01003', { key: '01003', name: 'Baldwin, AL', geometry: square(2) }],
  ['51019', { key: '51019', name: 'Bedford, VA', geometry: square(4) }],
])

describe('columns', () => {
  it('infers types, keeping zero-padded codes as text', () => {
    const cols = inferColumns([
      { fips: '01001', n: '3', x: '2.5', ok: 'True', when: '2025-01-01', name: 'A', geom: 'POINT (1 2)' },
      { fips: '01003', n: '4', x: '', ok: 'false', when: '2025-02-01', name: 'B', geom: 'POINT (3 4)' },
    ])
    expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toEqual({
      fips: 'string', n: 'int', x: 'double', ok: 'boolean', when: 'datetime', name: 'string', geom: 'point',
    })
    expect(coerce('', 'int')).toBeNull()
    expect(coerce('True', 'boolean')).toBe(true)
  })
})

describe('aggregate', () => {
  it('reduces values', () => {
    expect(aggregate([1, 2, null, 3], 'sum')).toBe(6)
    expect(aggregate([1, 2, 3], 'mean')).toBe(2)
    expect(aggregate(['a', 'b', 'a'], 'mode')).toBe('a')
    expect(aggregate(['a', 'b', 'a', null], 'count')).toBe(3)
    expect(aggregate(['a', 'b', 'a'], 'distinct')).toBe(2)
    expect(aggregate([false, true], 'any')).toBe(true)
    expect(aggregate(['2025-01-01', '2024-01-01'], 'max')).toBe('2025-01-01')
    expect(aggregate([], 'sum')).toBeNull()
    expect(defaultAggregation('int', 1)).toBe('first')
    expect(defaultAggregation('string', 5)).toBe('mode')
  })
})

describe('bindings', () => {
  it('normalizes region codes', () => {
    expect(boundaryKey('us-counties', 1001)).toBe('01001')
    expect(boundaryKey('us-counties', '1001.0')).toBe('01001')
    expect(boundaryKey('us-counties', '51515')).toBe('51019') // retired → successor
    expect(boundaryKey('us-counties', 'Autauga')).toBeNull()
    expect(boundaryKey('us-states', 'tx')).toBe('48')
    expect(boundaryKey('us-states', 'Texas')).toBe('48')
    expect(boundaryKey('us-states', 6)).toBe('06')
  })

  it('parses WKT and GeoJSON cells', () => {
    expect(parseWkt('POINT (-90 35)')).toEqual({ type: 'Point', coordinates: [-90, 35] })
    expect(parseWkt('LINESTRING Z (0 0 1, 1 1 2)')).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })
    expect(parseWkt('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((2 2, 3 2, 3 3, 2 2)))')?.type).toBe('MultiPolygon')
    expect(parseWkt('MULTIPOINT (1 2, 3 4)')).toEqual({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] })
    expect(parseWkt('SRID=4326;POINT (1 2)')).toEqual({ type: 'Point', coordinates: [1, 2] })
    expect(parseWkt('POLYGON ((0 0, 1 0')).toBeNull()
    expect(geometryFromValue('{"type":"Point","coordinates":[1,2]}')).toEqual({ type: 'Point', coordinates: [1, 2] })
    expect(geometryFromValue({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} })?.type).toBe('Point')
    expect(geometryFromValue('nonsense')).toBeNull()
  })

  it('groups rows per feature and counts misses', () => {
    const recs = [{ f: '01001' }, { f: '1001' }, { f: '01003' }, { f: '99999' }, { f: '51515' }]
    const r = groupRows(recs, { kind: 'boundary', column: 'f', boundary: 'us-counties' }, counties)
    expect(r.groups.map((g) => [g.key, g.rows.length])).toEqual([['01001', 2], ['01003', 1], ['51019', 1]])
    expect(r.unmatched).toBe(1)
    const all = groupRows(recs.slice(0, 1), { kind: 'boundary', column: 'f', boundary: 'us-counties', includeEmpty: true }, counties)
    expect(all.groups).toHaveLength(3)
    const p = (x: number) => ({ type: 'Point', coordinates: [x, 0] })
    const pts = groupRows([{ g: p(1) }, { g: p(1) }, { g: p(2) }, { g: null }], { kind: 'geometry', column: 'g' })
    expect(pts.groups.map((x) => x.rows.length)).toEqual([2, 1]) // the same point is one feature
    expect(pts.unmatched).toBe(1)
  })

  it('guesses a binding: a geometry column (regions first), else region codes — never lat/lon pairs', () => {
    const c = (name: string, type: ColumnType = 'string') => ({ name, type })
    expect(guessBinding([c('name'), c('Latitude', 'double'), c('Longitude', 'double')])).toBeNull()
    expect(guessBinding([c('county_fips'), c('state')])).toMatchObject({ kind: 'boundary', column: 'county_fips', boundary: 'us-counties' })
    expect(guessBinding([c('state'), c('value', 'double')])).toMatchObject({ boundary: 'us-states' })
    expect(guessBinding([c('site', 'point'), c('area', 'region'), c('fips')])).toEqual({ kind: 'geometry', column: 'area' })
    expect(guessBinding([c('a'), c('b')])).toBeNull()
    expect(isSupportedBinding({ kind: 'latlon', lat: 'a', lon: 'b' } as never)).toBe(false)
  })

  it('types geometry columns by kind and coerces their cells to GeoJSON', () => {
    const cols = inferColumns([
      { site: 'POINT (-90 35)', line: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, area: '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}' },
      { site: 'POINT (-91 36)', line: null, area: 'MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))' },
    ])
    expect(cols.map((x) => x.type)).toEqual(['point', 'polyline', 'region'])
    expect(coerce('POINT (-90 35)', 'point')).toEqual({ type: 'Point', coordinates: [-90, 35] })
    expect(coerce('POINT (-90 35)', 'region')).toBeNull() // wrong kind for the column
  })

  it('makes a point column from latitude and longitude', () => {
    const rows = withPointColumn([{ la: '35', lo: '-90' }, { la: '', lo: '-90' }, { la: '95', lo: 1 }], 'loc', 'la', 'lo')
    expect(rows.map((r) => r.loc)).toEqual([{ type: 'Point', coordinates: [-90, 35] }, null, null])
    expect(guessLatLon([{ name: 'Latitude' }, { name: 'lng' }])).toEqual({ lat: 'Latitude', lon: 'lng' })
    expect(guessLatLon([{ name: 'lat' }])).toBeNull()
  })
})

describe('vectors', () => {
  it('parses vector cells', () => {
    expect(parseVector('[3, -1]')).toEqual({ u: 3, v: -1 })
    expect(parseVector('(3,-1)')).toEqual({ u: 3, v: -1 })
    expect(parseVector('3, -1')).toEqual({ u: 3, v: -1 })
    expect(parseVector('{"u":1,"v":2}')).toEqual({ u: 1, v: 2 })
    expect(parseVector({ x: 1, y: 2 })).toEqual({ u: 1, v: 2 })
    expect(parseVector([1, 2])).toEqual({ u: 1, v: 2 })
    expect(parseVector('3.1')).toBeNull()
    expect(parseVector('3 1')).toBeNull()
    expect(parseVector('abc')).toBeNull()
  })

  it('infers vector columns and aggregates them component-wise', () => {
    const cols = inferColumns([{ flow: '[1, 0]' }, { flow: '[0, 1]' }])
    expect(cols[0].type).toBe('vector')
    expect(aggregate([{ u: 1, v: 0 }, { u: 0, v: 1 }, null], 'mean')).toEqual({ u: 0.5, v: 0.5 })
    expect(aggregate([{ u: 1, v: 0 }, { u: 0, v: 1 }], 'sum')).toEqual({ u: 1, v: 1 })
  })

  it('builds a vector column from two numeric columns', () => {
    const rows = withVectorColumn([{ e: '1', n: '2' }, { e: '', n: '2' }], 'wind', 'e', 'n')
    expect(rows.map((r) => r.wind)).toEqual([{ u: 1, v: 2 }, null])
  })
})

describe('visualization queries', () => {
  const records = withVectorColumn(
    [
      { county_fips: '01001', utility: 'Alabama Power', type: 'IOU', customers: '100', u: '1', v: '0' },
      { county_fips: '01001', utility: 'Central Coop', type: 'Coop', customers: '50', u: '0', v: '1' },
      { county_fips: '01003', utility: 'Alabama Power', type: 'IOU', customers: '100', u: '2', v: '2' },
    ],
    'flow',
    'u',
    'v',
  )
  const columns = inferColumns(records)
  const binding = { kind: 'boundary' as const, column: 'county_fips', boundary: 'us-counties' as const }
  const g = groupDataset(records, columns, binding, counties)
  const shape = bindingInfo(g, columns, binding)

  it('describes the dataset under a binding', () => {
    expect(shape).toMatchObject({ maxRowsPerFeature: 2, features: 2, matchedRows: 3, unmatched: 0, geometryKind: 'region' })
    expect(shape.columns.map((c) => c.name)).not.toContain('county_fips')
    const empty = bindingInfo(groupDataset(records, columns, { ...binding, includeEmpty: true }, counties), columns, binding)
    expect(empty.features).toBe(2) // empty regions don't count as matched features
  })

  it('picks the visualization kind from the column type', () => {
    expect(defaultVisualization(shape, 'ds', binding)).toMatchObject({ column: ROWS, aggregation: 'count', kind: 'scalar', binding })
    expect(makeVisualization(shape, 'ds', binding, 'flow')).toMatchObject({ kind: 'vector', aggregation: 'mean' })
    expect(makeVisualization(shape, 'ds', binding, 'customers').kind).toBe('scalar')
    expect(makeVisualization(shape, 'ds', binding, 'flow', 'count').kind).toBe('scalar') // a count of vectors is a number
    expect((makeVisualization(shape, 'ds', binding, 'type') as { style: { color: { kind: string } } }).style.color.kind).toBe('categorical')
  })

  it('computes one value per feature and attaches boundary polygons on the client side', () => {
    const count = queryValues(g, columns, ROWS, 'count', false)
    expect(count.features.map((f) => [f.key, f.value, f.geometry])).toEqual([['01001', 2, undefined], ['01003', 1, undefined]])
    const mean = makeVisualization(shape, 'ds', binding, 'customers', 'mean')
    const layer = visualizationLayer(queryValues(g, columns, 'customers', 'mean', false), mean, 'Utilities', counties)
    expect(layer.id).toBe(mean.id)
    expect(layer.features[0].properties).toMatchObject({ [VALUE]: 75, _label: 'Autauga, AL', _rows: 2 })
    expect(layer.features[0].geometry).toEqual(square(0))
    expect(layer.fields[0]).toMatchObject({ name: VALUE, type: 'double' })
    const flow = queryValues(g, columns, 'flow', 'sum', false)
    expect(flow.features[0].value).toEqual({ u: 1, v: 1 })
    expect(flow.valueType).toBe('vector')
    expect(queryValues(g, columns, 'type', 'mode', false).features[0].value).toBe('Coop') // mode tie → alphabetical
  })

  it('carries geometry for geometry-column bindings', () => {
    const pts = withPointColumn([{ lat: '35', lon: '-90', mw: '5' }, { lat: '35', lon: '-90', mw: '7' }, { lat: 'x', lon: '1', mw: '1' }], 'loc', 'lat', 'lon')
    const c = inferColumns(pts)
    expect(c.find((x) => x.name === 'loc')!.type).toBe('point')
    const v = queryValues(groupDataset(pts, c, { kind: 'geometry', column: 'loc' }), c, 'mw', 'sum', true)
    expect(v).toMatchObject({ geometryKind: 'point', unmatched: 1 })
    expect(v.features).toEqual([{ key: 'f1', label: 'f1', rows: 2, value: 12, geometry: { type: 'Point', coordinates: [-90, 35] } }])
    const shape = { columns: c.filter((x) => x.name !== 'loc'), maxRowsPerFeature: 1, geometryKind: 'point' as const }
    expect(defaultVisualization(shape, 'ds', { kind: 'geometry', column: 'loc' }).column).toBe('mw') // not a coordinate
  })

  it('retargets a visualization, keeping its style only when the value kind matches', () => {
    const l = makeVisualization(shape, 'ds', binding, 'customers', 'sum')
    const sameKind = retarget(shape, l, 'customers', 'mean')
    expect(sameKind.style).toBe(l.style)
    expect(sameKind.id).toBe(l.id)
    const toVector = retarget(shape, l, 'flow', 'mean')
    expect(toVector.kind).toBe('vector')
    expect(toVector.name).toBe('flow')
  })
})

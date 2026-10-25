import { describe, expect, it } from 'vitest'
import { aggregate, defaultAggregation } from './aggregate'
import { boundaryKey, geometryFromValue, groupRows, guessBinding, type BoundaryFeature } from './binding'
import { coerce, inferColumns } from './columns'
import { parseWkt } from './wkt'
import { buildDataset, withVectorColumn } from './dataset'
import { defaultVisualization, visualizationData, makeVisualization, retarget, ROWS, VALUE } from './visualization'
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
      fips: 'string', n: 'int', x: 'double', ok: 'boolean', when: 'datetime', name: 'string', geom: 'geometry',
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
    const pts = groupRows([{ la: '35', lo: '-90' }, { la: '', lo: '-90' }, { la: null, lo: 1 }], { kind: 'latlon', lat: 'la', lon: 'lo' })
    expect(pts.groups[0].geometry).toEqual({ type: 'Point', coordinates: [-90, 35] })
    expect(pts.unmatched).toBe(2)
  })

  it('guesses a binding from column names', () => {
    const c = (name: string, type: 'string' | 'double' | 'geometry' = 'string') => ({ name, type })
    expect(guessBinding([c('name'), c('Latitude', 'double'), c('Longitude', 'double')])).toEqual({ kind: 'latlon', lat: 'Latitude', lon: 'Longitude' })
    expect(guessBinding([c('county_fips'), c('state')])).toMatchObject({ kind: 'boundary', column: 'county_fips', boundary: 'us-counties' })
    expect(guessBinding([c('state'), c('value', 'double')])).toMatchObject({ boundary: 'us-states' })
    expect(guessBinding([c('wkt', 'geometry')])).toEqual({ kind: 'geometry', column: 'wkt' })
    expect(guessBinding([c('a'), c('b')])).toBeNull()
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

describe('datasets and visualizations', () => {
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
  const binding = { kind: 'boundary' as const, column: 'county_fips', boundary: 'us-counties' as const }
  const built = buildDataset({ id: 'ds', name: 'Utilities', binding }, records, inferColumns(records), counties)

  it('builds one feature per region with default aggregates', () => {
    expect(built.maxRowsPerFeature).toBe(2)
    expect(built.columns.map((c) => c.name)).not.toContain('county_fips')
    const autauga = built.base.features.find((f) => f.id === '01001')!.properties
    expect(autauga).toMatchObject({ _label: 'Autauga, AL', _rows: 2, customers: 150, type: 'Coop' }) // mode tie → alphabetical
    expect(autauga.flow).toEqual({ u: 0.5, v: 0.5 })
    expect(built.rowsByKey.get('01001')).toHaveLength(2)
  })

  it('picks the layer kind from the column type', () => {
    expect(defaultVisualization(built, 'ds')).toMatchObject({ column: ROWS, aggregation: 'count', kind: 'scalar' })
    expect(makeVisualization(built, 'ds', 'flow')).toMatchObject({ kind: 'vector', aggregation: 'mean' })
    expect(makeVisualization(built, 'ds', 'customers').kind).toBe('scalar')
    expect(makeVisualization(built, 'ds', 'flow', 'count').kind).toBe('scalar') // a count of vectors is a number
    expect((makeVisualization(built, 'ds', 'type') as { style: { color: { kind: string } } }).style.color.kind).toBe('categorical')
  })

  it('computes each layer\'s value per feature', () => {
    const count = visualizationData(built, 'Utilities', defaultVisualization(built, 'ds'))
    expect(count.features.map((f) => f.properties[VALUE])).toEqual([2, 1])
    const mean = makeVisualization(built, 'ds', 'customers', 'mean')
    const data = visualizationData(built, 'Utilities', mean)
    expect(data.id).toBe(mean.id)
    expect(data.features[0].properties[VALUE]).toBe(75)
    expect(data.fields[0]).toMatchObject({ name: VALUE, type: 'double' })
    const flow = visualizationData(built, 'Utilities', makeVisualization(built, 'ds', 'flow', 'sum'))
    expect(flow.features[0].properties[VALUE]).toEqual({ u: 1, v: 1 })
    expect(flow.fields[0].type).toBe('vector')
  })

  it('retargets a layer, keeping its style only when the value kind matches', () => {
    const l = makeVisualization(built, 'ds', 'customers', 'sum')
    const sameKind = retarget(built, l, 'customers', 'mean')
    expect(sameKind.style).toBe(l.style)
    expect(sameKind.id).toBe(l.id)
    const toVector = retarget(built, l, 'flow', 'mean')
    expect(toVector.kind).toBe('vector')
    expect(toVector.name).toBe('flow')
  })
})

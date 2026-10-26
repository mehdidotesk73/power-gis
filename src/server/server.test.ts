import { describe, expect, it } from 'vitest'
import { createServer } from './server'
import { nodeDuckDb } from './testEngine'
import { MemoryDatabase } from '../shared/database'
import type { ApiResult } from '../shared/api'
import type { BoundaryFeature } from '../lib/dataset/binding'
import { defaultScalarStyle, settingsOf, makeVisualization, ROWS } from '../lib/dataset/visualization'

const square = (x: number) => ({ type: 'Polygon' as const, coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] })
const counties = new Map<string, BoundaryFeature>([
  ['01001', { key: '01001', name: 'Autauga, AL', geometry: square(0) }],
  ['01003', { key: '01003', name: 'Baldwin, AL', geometry: square(2) }],
])
const CSV = 'county_fips,utility,mw,flow,location\n01001,A,5,"[5, 1]",POINT (-86.6 32.5)\n01001,B,7,"[7, 1]",POINT (-86.6 32.5)\n01003,A,1,"[1, 1]",POINT (-87.7 30.7)\n99999,C,2,"[2, 1]",\n'
const file = (name: string, text: string) => ({ name, text: async () => text }) as unknown as File

function setup() {
  const db = new MemoryDatabase()
  const server = createServer(db, {
    loadBoundaries: async () => counties,
    readBuiltin: async (table) => (table === 'utilities' ? [{ utility_id: 1, name: 'Alabama Power' }] : []),
    sql: nodeDuckDb,
  })
  return { db, server }
}
const data = <T,>(r: ApiResult<T>): T => {
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}
const county = { kind: 'boundary' as const, column: 'county_fips', boundary: 'us-counties' as const }

describe('server', () => {
  it('uploads a file into its own data table and registers it', async () => {
    const { db, server } = setup()
    data(await server.handle('init', { baseUrl: '/' }))
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('plants.csv', CSV) } }))
    const ds = (await db.get('datasets', datasetId))!
    expect(ds).toMatchObject({ name: 'plants', rowCount: 4, origin: 'Device · plants.csv', table: `ds_${datasetId.replace(/-/g, '')}` })
    expect(ds.columns.find((c) => c.name === 'county_fips')!.type).toBe('string') // zero-padded codes stay text
    expect(ds.columns.map((c) => c.type)).toEqual(['string', 'string', 'int', 'vector', 'point'])
    expect(await db.readRows(ds.table)).toHaveLength(4)
    expect((await server.handle('uploadDataset', { source: { kind: 'csv', file: file('e.csv', 'a\n') } })).ok).toBe(false)
  })

  it('answers visualization queries with one value per feature', async () => {
    const { server } = setup()
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } }))
    const info = data(await server.handle('describeBinding', { datasetId, binding: county }))
    expect(info).toMatchObject({ features: 2, matchedRows: 3, unmatched: 1, unmatchedSamples: ['99999'], maxRowsPerFeature: 2 })
    expect(info.columns.map((c) => c.name)).not.toContain('county_fips')
    const sum = data(await server.handle('queryVisualization', { datasetId, binding: county, column: 'mw', aggregation: 'sum' }))
    expect(sum.features.map((f) => [f.key, f.value, f.rows, f.geometry])).toEqual([['01001', 12, 2, undefined], ['01003', 1, 1, undefined]])
    const pts = data(await server.handle('queryVisualization', { datasetId, binding: { kind: 'geometry', column: 'location' }, column: ROWS, aggregation: 'count' }))
    expect(pts.features[0]).toMatchObject({ rows: 2, geometry: { type: 'Point', coordinates: [-86.6, 32.5] } })
    expect(pts).toMatchObject({ geometryKind: 'point', unmatched: 1 })
    const notGeom = await server.handle('describeBinding', { datasetId, binding: { kind: 'geometry', column: 'utility' } })
    expect(notGeom).toMatchObject({ ok: false, error: { message: expect.stringContaining('not a geometry column') } })
    const rows = data(await server.handle('featureRows', { datasetId, binding: county, key: '01001' }))
    expect(rows.map((r) => r.utility)).toEqual(['A', 'B'])
    const bad = await server.handle('queryVisualization', { datasetId, binding: { ...county, column: 'nope' }, column: 'mw', aggregation: 'sum' })
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid' } })
  })

  it('aggregates vector cells component-wise', async () => {
    const { server } = setup()
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } }))
    const v = data(await server.handle('queryVisualization', { datasetId, binding: county, column: 'flow', aggregation: 'sum' }))
    expect(v.valueType).toBe('vector')
    expect(v.features[0].value).toEqual({ u: 12, v: 2 })
  })

  it('saves workspaces as pointers, and deleting a dataset cleans up after it', async () => {
    const { db, server } = setup()
    data(await server.handle('init', { baseUrl: '/' }))
    const a = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } })).datasetId
    const b = data(await server.handle('uploadDataset', { source: { kind: 'builtin', table: 'utilities' } })).datasetId
    expect((await db.get('datasets', b))!.name).toBe('EIA-861 utility list (no geometry)')
    const shape = { columns: [], maxRowsPerFeature: 2, geometryKind: 'region' as const }
    const v1 = makeVisualization(shape, a, county, ROWS)
    const v2 = { ...makeVisualization(shape, a, county, ROWS), name: 'Second' }
    const viz = (v: typeof v1) => ({ id: v.id, name: v.name, datasetId: v.datasetId, settings: settingsOf(v) })
    const { workspaceId } = data(await server.handle('saveWorkspace', { name: 'Mine', config: { datasetIds: [a, b] }, visualizations: [viz(v1), viz(v2)] }))
    const w = (await db.get('workspaces', workspaceId))!
    expect(w.config).toEqual({ datasetIds: [a, b], visualizationIds: [v1.id, v2.id], transformIds: [] })
    expect(JSON.stringify(w)).not.toContain('Alabama') // pointers, never rows
    expect((await db.get('visualizations', v1.id))!.settings).toMatchObject({ binding: county, column: ROWS })

    // Dropping a visualization from the workspace deletes its record.
    data(await server.handle('saveWorkspace', { id: workspaceId, name: 'Mine', config: { datasetIds: [a, b] }, visualizations: [viz(v2)] }))
    expect(await db.get('visualizations', v1.id)).toBeUndefined()

    const foreign = { ...viz(v2), id: crypto.randomUUID(), datasetId: 'other' }
    expect(await server.handle('saveWorkspace', { id: workspaceId, name: 'Mine', config: { datasetIds: [a] }, visualizations: [foreign] })).toMatchObject({ ok: false })

    data(await server.handle('deleteDataset', { id: a }))
    expect(await db.get('visualizations', v2.id)).toBeUndefined()
    expect((await db.get('workspaces', workspaceId))!.config).toEqual({ datasetIds: [b], visualizationIds: [], transformIds: [] })
    expect(await db.readRows(`ds_${a.replace(/-/g, '')}`)).toBeUndefined()
  })

  it('renames datasets and reports unknown requests and ids', async () => {
    const { db, server } = setup()
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } }))
    data(await server.handle('updateDataset', { id: datasetId, name: ' Plants ', description: 'test', extensions: { x: 1 } }))
    expect(await db.get('datasets', datasetId)).toMatchObject({ name: 'Plants', description: 'test', extensions: { x: 1 } })
    expect(await server.handle('updateDataset', { id: 'zz' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(await server.handle('nope' as never, {} as never)).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(defaultScalarStyle('int', 'region').color.kind).toBe('colormap')
  })

  it('runs transforms: a new output, then the same output again, as pointers', async () => {
    const { db, server } = setup()
    data(await server.handle('init', { baseUrl: '/' }))
    const PLANTS = 'name,lat,lon,mw\nA,35.1,-90,500\nB,40.7,-74,1200\nC,,-90,300\n'
    const src = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('plants.csv', PLANTS) } })).datasetId
    expect((await db.get('datasets', src))!.profile).toMatchObject({ rowCount: 3, columns: expect.arrayContaining([expect.objectContaining({ name: 'lat', filled: 2 })]) })
    const inputs = [{ datasetId: src, alias: 'plants' }]

    const preview = data(await server.handle('previewTransform', { sql: 'SELECT name, point(lon, lat) AS location, mw FROM plants', inputs, limit: 2 }))
    expect(preview).toMatchObject({ rowCount: 3, rows: expect.any(Array) })
    expect(preview.rows).toHaveLength(2)
    expect(preview.columns.map((c) => c.type)).toEqual(['string', 'point', 'int'])
    const bad = await server.handle('previewTransform', { sql: 'SELECT nope FROM plants', inputs })
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid', message: expect.stringContaining('nope') } })

    const tr = { id: crypto.randomUUID(), name: 'Plant points', sql: 'SELECT name, point(lon, lat) AS location, mw FROM plants WHERE lat IS NOT NULL', inputs }
    data(await server.handle('saveWorkspace', { name: 'W', config: { datasetIds: [src] }, visualizations: [], transforms: [tr] }))
    const first = data(await server.handle('runTransform', { transform: tr }))
    expect(first).toMatchObject({ rowCount: 2, created: true })
    const out = (await db.get('datasets', first.datasetId))!
    expect(out).toMatchObject({ name: 'Plant points', origin: 'Transform · Plant points', rowCount: 2 })
    expect(out.columns).toEqual([{ name: 'name', type: 'string' }, { name: 'location', type: 'point' }, { name: 'mw', type: 'int' }])
    expect((await db.get('transforms', tr.id))!.outputId).toBe(first.datasetId) // the saved transform remembers its output

    // Visualize the output's point column.
    const pts = data(await server.handle('queryVisualization', { datasetId: first.datasetId, binding: { kind: 'geometry', column: 'location' }, column: 'mw', aggregation: 'sum' }))
    expect(pts.features.map((f) => f.value)).toEqual([500, 1200])

    // Re-running with the output id overwrites that dataset; cached values are recomputed.
    const again = data(await server.handle('runTransform', { transform: { ...tr, sql: 'SELECT name, point(lon, lat) AS location, mw * 2 AS mw FROM plants WHERE lat IS NOT NULL', outputId: first.datasetId } }))
    expect(again).toEqual({ datasetId: first.datasetId, rowCount: 2, created: false })
    const pts2 = data(await server.handle('queryVisualization', { datasetId: first.datasetId, binding: { kind: 'geometry', column: 'location' }, column: 'mw', aggregation: 'sum' }))
    expect(pts2.features.map((f) => f.value)).toEqual([1000, 2400])

    // Deleting the output: the transform makes a new one next time. Dropping the transform from the workspace deletes it.
    data(await server.handle('deleteDataset', { id: first.datasetId }))
    expect((await db.get('transforms', tr.id))!.outputId).toBeUndefined()
    const w = (await db.list('workspaces'))[0]
    data(await server.handle('saveWorkspace', { id: w.id, name: 'W', config: { datasetIds: [src] }, visualizations: [], transforms: [] }))
    expect(await db.get('transforms', tr.id)).toBeUndefined()
    expect(await server.handle('runTransform', { transform: { ...tr, inputs: [] } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('input') } })
  })

  it('profiles a dataset that was stored without one', async () => {
    const { db, server } = setup()
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } }))
    const ds = (await db.get('datasets', datasetId))!
    await db.put('datasets', { ...ds, profile: undefined })
    const p = data(await server.handle('profileDataset', { datasetId }))
    expect(p.rowCount).toBe(4)
    expect((await db.get('datasets', datasetId))!.profile).toEqual(p)
  })
})

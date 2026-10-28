import { describe, expect, it } from 'vitest'
import { emptyWorkspace } from '../lib/workspace/workspace'
import { createServer } from './server'
import { nodeDuckDb } from './testEngine'
import { MemoryDatabase } from '../shared/database'
import { readFileSync } from 'node:fs'
import { countyRows, stateRows } from '../lib/data/boundaryTables'
import { parseWorkspaceFile, replaceDatasetIds, toWorkspaceFile, type WorkspaceFile } from '../lib/workspace/file'
import type { ApiResult } from '../shared/api'
import type { CloudDataset, CloudStore, CloudWorkspace } from '../shared/cloud'
import { defaultScalarStyle, settingsOf, makeVisualization, ROWS } from '../lib/dataset/visualization'

const SQ0 = '"POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))"'
const SQ2 = '"POLYGON ((2 0, 3 0, 3 1, 2 1, 2 0))"'
// A joined table: county shapes repeated per utility, plus a row with no shape.
const CSV =
  'county_fips,county,area,utility,mw,flow,location\n' +
  `01001,Autauga,${SQ0},A,5,"[5, 1]",POINT (-86.6 32.5)\n` +
  `01001,Autauga,${SQ0},B,7,"[7, 1]",POINT (-86.6 32.5)\n` +
  `01003,Baldwin,${SQ2},A,1,"[1, 1]",POINT (-87.7 30.7)\n` +
  '99999,Nowhere,,C,2,"[2, 1]",\n'
const file = (name: string, text: string) => ({ name, text: async () => text }) as unknown as File

function setup() {
  const db = new MemoryDatabase()
  const server = createServer(db, {
    readBuiltin: async (table) => (table === 'utilities' ? [{ utility_id: 1, name: 'Alabama Power' }] : []),
    sql: nodeDuckDb,
  })
  return { db, server }
}
const data = <T,>(r: ApiResult<T>): T => {
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}
const county = { kind: 'geometry' as const, column: 'area', label: 'county' }

describe('server', () => {
  it('saves a workspace that points at datasets unavailable here, keeping what is known of them', async () => {
    const { db, server } = setup()
    data(await server.handle('init', { baseUrl: '/' }))
    const here = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('a.csv', 'x\n1\n') } })).datasetId
    const unavailable = { gone: { name: 'plants', rows: 412, why: 'elsewhere' as const } }
    // Unknown and not marked unavailable: refused, as before.
    expect(await server.handle('saveWorkspace', { name: 'W', config: { datasetIds: [here, 'gone'] }, visualizations: [] })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    const { workspaceId } = data(await server.handle('saveWorkspace', { name: 'W', config: { datasetIds: [here, 'gone'], unavailable }, visualizations: [] }))
    expect((await db.get('workspaces', workspaceId))!.config).toMatchObject({ datasetIds: [here, 'gone'], unavailable })
  })

  it('saves on a restarted server that missed init, as the same local user', async () => {
    const { db, server } = setup()
    const { userId } = data(await server.handle('init', { baseUrl: '/' }))
    // A new worker on the same device database: no init before the save.
    const restarted = createServer(db, { readBuiltin: async () => [], sql: nodeDuckDb })
    const { workspaceId } = data(await restarted.handle('saveWorkspace', { name: 'W', config: { datasetIds: [] }, visualizations: [] }))
    expect((await db.get('workspaces', workspaceId))!.ownerId).toBe(userId)
    expect(await db.list('users')).toHaveLength(1)
  })

  it('uploads a file into its own data table and registers it', async () => {
    const { db, server } = setup()
    data(await server.handle('init', { baseUrl: '/' }))
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('plants.csv', CSV) } }))
    const ds = (await db.get('datasets', datasetId))!
    expect(ds).toMatchObject({ name: 'plants', rowCount: 4, origin: 'Device · plants.csv', table: `ds_${datasetId.replace(/-/g, '')}` })
    expect(ds.columns.find((c) => c.name === 'county_fips')!.type).toBe('string') // zero-padded codes stay text
    expect(ds.columns.map((c) => c.type)).toEqual(['string', 'string', 'region', 'string', 'int', 'vector', 'point'])
    expect(await db.readRows(ds.table)).toHaveLength(4)
    expect((await server.handle('uploadDataset', { source: { kind: 'csv', file: file('e.csv', 'a\n') } })).ok).toBe(false)
  })

  it('answers visualization queries with one value per feature', async () => {
    const { server } = setup()
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } }))
    const info = data(await server.handle('describeBinding', { datasetId, binding: county }))
    expect(info).toMatchObject({ features: 2, matchedRows: 3, unmatched: 1, maxRowsPerFeature: 2 })
    expect(info.columns.map((c) => c.name)).not.toContain('area')
    const sum = data(await server.handle('queryVisualization', { datasetId, binding: county, column: 'mw', aggregation: 'sum' }))
    expect(sum.features.map((f) => [f.key, f.label, f.value, f.rows, f.geometry.type])).toEqual([['f1', 'Autauga', 12, 2, 'Polygon'], ['f2', 'Baldwin', 1, 1, 'Polygon']])
    const pts = data(await server.handle('queryVisualization', { datasetId, binding: { kind: 'geometry', column: 'location' }, column: ROWS, aggregation: 'count' }))
    expect(pts.features[0]).toMatchObject({ rows: 2, geometry: { type: 'Point', coordinates: [-86.6, 32.5] } })
    expect(pts).toMatchObject({ geometryKind: 'point', unmatched: 1 })
    const notGeom = await server.handle('describeBinding', { datasetId, binding: { kind: 'geometry', column: 'utility' } })
    expect(notGeom).toMatchObject({ ok: false, error: { message: expect.stringContaining('not a geometry column') } })
    const rows = data(await server.handle('featureRows', { datasetId, binding: county, key: 'f1' }))
    expect(rows.map((r) => r.utility)).toEqual(['A', 'B'])
    const bad = await server.handle('queryVisualization', { datasetId, binding: { ...county, label: 'nope' }, column: 'mw', aggregation: 'sum' })
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
    expect((await db.get('datasets', b))!).toMatchObject({ name: 'EIA-861 utilities', origin: 'Built-in · utilities', extensions: { builtin: 'utilities' } })
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

  it('keeps new datasets in the local store; storing one in the cloud needs a signed-in user', async () => {
    const { db, server } = setup()
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } }))
    expect((await db.get('datasets', datasetId))!.store).toBe('local')
    expect(await server.handle('storeInCloud', { id: datasetId })).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect((await db.get('datasets', datasetId))!.store).toBe('local')
  })

  it("refuses an agent's changes to remote datasets, and allows them on local ones", async () => {
    const { db, server } = setup()
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } }))
    const local = (await db.get('datasets', datasetId))!
    const remoteId = crypto.randomUUID()
    await db.put('datasets', { ...local, id: remoteId, table: `ds_${remoteId.replace(/-/g, '')}`, store: 'remote' })
    await db.writeRows(`ds_${remoteId.replace(/-/g, '')}`, (await db.readRows(local.table))!)
    const writes = (outputId: string) => ({ transform: { id: 't', name: 'T', inputs: [{ datasetId, alias: 'p' }], outputs: [{ key: 'o', name: 'out', sql: 'SELECT county FROM p', outputId }] } })
    expect(await server.handle('runTransform', writes(remoteId), 'agent')).toMatchObject({ ok: false, error: { message: expect.stringContaining('only local datasets') } })
    expect(await server.handle('deleteDataset', { id: remoteId }, 'agent')).toMatchObject({ ok: false })
    expect(await server.handle('updateDataset', { id: remoteId, name: 'x' }, 'agent')).toMatchObject({ ok: false })
    expect(await server.handle('storeInCloud', { id: datasetId }, 'agent')).toMatchObject({ ok: false })
    expect(await server.handle('fetchFromCloud', { id: remoteId }, 'agent')).toMatchObject({ ok: false })
    // Reading a remote dataset is fine; so are changes to local ones, and the user may do anything.
    expect(data(await server.handle('previewTransform', { sql: 'SELECT count(*) AS n FROM r', inputs: [{ datasetId: remoteId, alias: 'r' }] }, 'agent')).rows[0].n).toBe(4)
    expect(data(await server.handle('runTransform', { transform: { ...writes(remoteId).transform, outputs: [{ key: 'o', name: 'out', sql: 'SELECT county FROM r' }], inputs: [{ datasetId: remoteId, alias: 'r' }] } }, 'agent')).outputs[0].created).toBe(true)
    // Deleting a cloud dataset deletes it from the cloud too: signed out, the user is asked to sign in.
    expect(await server.handle('deleteDataset', { id: remoteId })).toMatchObject({ ok: false, error: { code: 'unsupported', message: expect.stringContaining('sign in') } })
  })

  it('renames datasets and reports unknown requests and ids', async () => {
    const { db, server } = setup()
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } }))
    data(await server.handle('updateDataset', { id: datasetId, name: ' Plants ', description: 'test', extensions: { x: 1 } }))
    expect(await db.get('datasets', datasetId)).toMatchObject({ name: 'Plants', description: 'test', extensions: { x: 1 } })
    // Renaming doesn't count as a change to the rows (transforms reading it stay up to date).
    const before = (await db.get('datasets', datasetId))!.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    data(await server.handle('updateDataset', { id: datasetId, name: 'Plants 2' }))
    expect((await db.get('datasets', datasetId))!.updatedAt).toBe(before)
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

    const preview = data(await server.handle('previewTransform', { sql: 'SELECT name, point(lat, lon) AS location, mw FROM plants', inputs, limit: 2 }))
    expect(preview).toMatchObject({ rowCount: 3, rows: expect.any(Array) })
    expect(preview.rows).toHaveLength(2)
    expect(preview.columns.map((c) => c.type)).toEqual(['string', 'point', 'int'])
    const bad = await server.handle('previewTransform', { sql: 'SELECT nope FROM plants', inputs })
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid', message: expect.stringContaining('nope') } })

    const pointsSql = 'SELECT name, point(lat, lon) AS location, mw FROM plants WHERE lat IS NOT NULL'
    const tr = { id: crypto.randomUUID(), name: 'Plant points', inputs, outputs: [{ key: 'o1', name: 'Plant points', sql: pointsSql }] }
    data(await server.handle('saveWorkspace', { name: 'W', config: { datasetIds: [src] }, visualizations: [], transforms: [tr] }))
    const [first] = data(await server.handle('runTransform', { transform: tr })).outputs
    expect(first).toMatchObject({ key: 'o1', rowCount: 2, created: true })
    const out = (await db.get('datasets', first.datasetId))!
    expect(out).toMatchObject({ name: 'Plant points', origin: 'Transform · Plant points', rowCount: 2 })
    expect(out.columns).toEqual([{ name: 'name', type: 'string' }, { name: 'location', type: 'point' }, { name: 'mw', type: 'int' }])
    expect((await db.get('transforms', tr.id))!.outputs[0].outputId).toBe(first.datasetId) // the saved transform remembers its output

    // Visualize the output's point column.
    const pts = data(await server.handle('queryVisualization', { datasetId: first.datasetId, binding: { kind: 'geometry', column: 'location' }, column: 'mw', aggregation: 'sum' }))
    expect(pts.features.map((f) => f.value)).toEqual([500, 1200])

    // Re-running with the output id overwrites that dataset; cached values are recomputed.
    const doubled = { key: 'o1', name: 'Plant points', sql: pointsSql.replace('mw FROM', 'mw * 2 AS mw FROM'), outputId: first.datasetId }
    const again = data(await server.handle('runTransform', { transform: { ...tr, outputs: [doubled] } }))
    expect(again.outputs).toEqual([{ key: 'o1', datasetId: first.datasetId, rowCount: 2, created: false }])
    const pts2 = data(await server.handle('queryVisualization', { datasetId: first.datasetId, binding: { kind: 'geometry', column: 'location' }, column: 'mw', aggregation: 'sum' }))
    expect(pts2.features.map((f) => f.value)).toEqual([1000, 2400])

    // Deleting the output: the transform makes a new one next time. Dropping the transform from the workspace deletes it.
    data(await server.handle('deleteDataset', { id: first.datasetId }))
    expect((await db.get('transforms', tr.id))!.outputs[0].outputId).toBeUndefined()
    const w = (await db.list('workspaces'))[0]
    data(await server.handle('saveWorkspace', { id: w.id, name: 'W', config: { datasetIds: [src] }, visualizations: [], transforms: [] }))
    expect(await db.get('transforms', tr.id)).toBeUndefined()
    expect(await server.handle('runTransform', { transform: { ...tr, inputs: [] } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('input') } })
  })

  it('runs every output of a transform, and writes none when one fails', async () => {
    const { db, server } = setup()
    const src = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', 'name,mw\nA,5\nB,7\n') } })).datasetId
    const inputs = [{ datasetId: src, alias: 'p' }]
    const outputs = [
      { key: 'big', name: 'Big plants', sql: 'SELECT * FROM p WHERE mw > 6' },
      { key: 'total', name: 'Total', sql: 'SELECT sum(mw) AS mw FROM p' },
    ]
    const r = data(await server.handle('runTransform', { transform: { id: 't', name: 'Split', inputs, outputs } }))
    expect(r.outputs.map((o) => [o.key, o.rowCount, o.created])).toEqual([['big', 1, true], ['total', 1, true]])
    expect((await db.get('datasets', r.outputs[0].datasetId))!.name).toBe('Big plants')
    expect(await db.readRows((await db.get('datasets', r.outputs[1].datasetId))!.table)).toEqual([{ mw: 12 }])
    const count = (await db.list('datasets')).length
    const bad = await server.handle('runTransform', { transform: { id: 't', name: 'Split', inputs, outputs: [outputs[0], { ...outputs[1], sql: 'SELECT nope FROM p' }] } })
    expect(bad).toMatchObject({ ok: false, error: { message: expect.stringContaining('Total:') } })
    expect((await db.list('datasets')).length).toBe(count) // nothing written
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

  it('finds features by name or by a text value in their rows', async () => {
    const { server } = setup()
    const { datasetId } = data(await server.handle('uploadDataset', { source: { kind: 'csv', file: file('p.csv', CSV) } }))
    const { entries } = data(await server.handle('findIndex', { datasetId, binding: county }))
    expect(entries).toEqual(
      expect.arrayContaining([
        { column: '_label', value: 'Autauga', features: 1 },
        { column: 'utility', value: 'A', features: 2 }, // utility A serves both counties
        { column: 'utility', value: 'B', features: 1 },
      ]),
    )
    expect(entries.some((e) => e.value === 'C')).toBe(false) // C's row has no shape
    expect(entries.some((e) => e.column === 'county')).toBe(false) // the label column is the feature names
    const a = data(await server.handle('findFeatures', { datasetId, binding: county, column: 'utility', value: 'A' }))
    expect(a.keys.sort()).toEqual(['f1', 'f2'])
    expect(data(await server.handle('findFeatures', { datasetId, binding: county, column: 'utility', value: 'nope' })).keys).toEqual([])
  })
})

describe('built-in boundary datasets and the default join', () => {
  it('turns us-atlas counties and states into tables with a region column', () => {
    const counties = countyRows(JSON.parse(readFileSync('node_modules/us-atlas/counties-10m.json', 'utf8')))
    const autauga = counties.find((r) => r.fips === '01001')!
    expect(autauga).toMatchObject({ name: 'Autauga, AL', county: 'Autauga', state: 'AL', state_fips: '01' })
    expect((autauga.geometry as { type: string }).type).toMatch(/Polygon/)
    const states = stateRows(JSON.parse(readFileSync('node_modules/us-atlas/states-10m.json', 'utf8')))
    expect(states.find((r) => r.fips === '48')).toMatchObject({ name: 'Texas', abbr: 'TX' })
  })

  it("runs the default workspace's join (counties × links × utilities), and a state-level view of the same tables", async () => {
    const tables: Record<string, Record<string, unknown>[]> = {
      us_counties: [
        { fips: '01001', name: 'Autauga, AL', county: 'Autauga', state: 'AL', state_fips: '01', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
        { fips: '01003', name: 'Baldwin, AL', county: 'Baldwin', state: 'AL', state_fips: '01', geometry: { type: 'Polygon', coordinates: [[[2, 0], [3, 0], [3, 1], [2, 0]]] } },
      ],
      utility_counties: [
        { utility_id_eia: '195', county_fips: '01001' },
        { utility_id_eia: '3222', county_fips: '01001' },
      ],
      utilities: [
        { utility_id_eia: '195', utility_name: 'Alabama Power Co', entity_type: 'Investor Owned' },
        { utility_id_eia: '3222', utility_name: 'Central Alabama Electric Coop', entity_type: 'Cooperative' },
      ],
      us_states: [{ fips: '01', name: 'Alabama', abbr: 'AL', geometry: { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 1], [0, 0]]] } }],
    }
    const db = new MemoryDatabase()
    const server = createServer(db, { readBuiltin: async (t) => tables[t], sql: nodeDuckDb })
    const parsed = parseWorkspaceFile(readFileSync('public/data/default.powergis.json', 'utf8'))
    if (!parsed.ok) throw new Error(parsed.error)
    const ids: Record<string, string> = {}
    for (const d of parsed.file.datasets) if (d.origin.kind === 'builtin') ids[d.id] = data(await server.handle('uploadDataset', { source: { kind: 'builtin', table: d.origin.table } })).datasetId
    const t = replaceDatasetIds(parsed.file, (p) => ids[p]).transforms[0]
    const [out] = data(await server.handle('runTransform', { transform: { ...t, id: 't', outputs: t.outputs.map((o) => ({ ...o, outputId: undefined })) } })).outputs
    expect(out.rowCount).toBe(3) // two utilities in Autauga, an empty row for Baldwin
    const ds = (await db.get('datasets', out.datasetId))!
    expect(ds.columns.find((c) => c.name === 'geometry')!.type).toBe('region')
    const n = parsed.file.visualizations.find((v) => v.name === 'Number of utilities')!
    const values = data(await server.handle('queryVisualization', { datasetId: out.datasetId, binding: n.binding, column: n.column, aggregation: n.aggregation }))
    expect(values.features.map((f) => [f.label, f.value])).toEqual([['Autauga, AL', 2], ['Baldwin, AL', 0]])
    const coop = data(await server.handle('queryVisualization', { datasetId: out.datasetId, binding: n.binding, column: 'cooperative', aggregation: 'any' }))
    expect(coop.features.map((f) => f.value)).toEqual([true, null])
    const rows = data(await server.handle('featureRows', { datasetId: out.datasetId, binding: n.binding, key: values.features[0].key }))
    expect(rows.map((r) => r.utility_name)).toEqual(['Alabama Power Co', 'Central Alabama Electric Coop'])

    // Rows come in pages from the server (the client never reads data tables).
    const page = data(await server.handle('datasetRows', { datasetId: out.datasetId, limit: 2, offset: 1 }))
    expect([page.rowCount, page.rows.length, page.columns.length]).toEqual([3, 2, ds.columns.length])

    // Exports are made on the server from its own grouping.
    const viz = { id: 'v1', name: 'Number of utilities', datasetId: out.datasetId, binding: n.binding, column: n.column, aggregation: n.aggregation }
    const gj = data(await server.handle('exportVisualization', { visualization: viz, format: 'geojson' }))
    expect(gj).toMatchObject({ fileName: 'v1.geojson', mimeType: 'application/geo+json' })
    expect(JSON.parse(gj.text).features).toHaveLength(2)
    const csv = data(await server.handle('exportVisualization', { visualization: viz, format: 'csv' }))
    expect(csv.text.trim().split('\n')).toHaveLength(3) // header + one row per feature
    expect(data(await server.handle('exportVisualization', { visualization: viz, format: 'esri' })).text).toContain('"features"')

    // State level: states ⋈ counties ⋈ links ⋈ utilities, grouped by state and utility.
    const states = data(await server.handle('uploadDataset', { source: { kind: 'builtin', table: 'us_states' } })).datasetId
    const byState = data(
      await server.handle('previewTransform', {
        sql: `SELECT s.geometry, s.name AS state, u.utility_name, count(*) AS counties
              FROM states s JOIN counties c ON c.state_fips = s.fips JOIN links l ON l.county_fips = c.fips JOIN utilities u USING (utility_id_eia)
              GROUP BY ALL ORDER BY u.utility_name`,
        inputs: [...t.inputs, { datasetId: states, alias: 'states' }],
      }),
    )
    expect(byState.rows.map((r) => [r.state, r.utility_name, r.counties])).toEqual([['Alabama', 'Alabama Power Co', 1], ['Alabama', 'Central Alabama Electric Coop', 1]])
    expect(byState.columns.find((c) => c.name === 'geometry')!.type).toBe('region')
  })

  it('prepares the default workspace on the server, reusing what it made before', async () => {
    const tables: Record<string, Record<string, unknown>[]> = {
      us_counties: [{ fips: '01001', name: 'Autauga, AL', county: 'Autauga', state: 'AL', state_fips: '01', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }],
      utility_counties: [{ utility_id_eia: '195', county_fips: '01001' }],
      utilities: [{ utility_id_eia: '195', utility_name: 'Alabama Power Co', entity_type: 'Investor Owned' }],
      us_states: [{ fips: '01', name: 'Alabama', abbr: 'AL', geometry: { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 1], [0, 0]]] } }],
    }
    const db = new MemoryDatabase()
    const server = createServer(db, { readBuiltin: async (t) => tables[t] ?? [], sql: nodeDuckDb, readDefaultWorkspace: async () => readFileSync('public/data/default.powergis.json', 'utf8') })
    data(await server.handle('init', { baseUrl: '/' }))
    const { file } = data(await server.handle('seedDefaultWorkspace', {}))
    const pointers = [...file.datasetIds, ...file.visualizations.map((v) => v.datasetId), ...(file.transforms ?? []).flatMap((t) => t.inputs.map((i) => i.datasetId))]
    expect(pointers.some((p) => p.includes(':'))).toBe(false)
    for (const id of file.datasetIds) expect(await db.get('datasets', id)).toBeTruthy()
    const count = (await db.list('datasets')).length
    // Again: the built-ins and the transforms' outputs are reused, nothing new is made.
    const again = data(await server.handle('seedDefaultWorkspace', {}))
    expect(again.file.datasetIds).toEqual(file.datasetIds)
    expect((await db.list('datasets')).length).toBe(count)
  })
})

describe('cloud workspace', () => {
  const tables: Record<string, Record<string, unknown>[]> = {
    us_counties: [{ fips: '01001', name: 'Autauga, AL', county: 'Autauga', state: 'AL', state_fips: '01', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }],
    utility_counties: [{ utility_id_eia: '195', county_fips: '01001' }],
    utilities: [{ utility_id_eia: '195', utility_name: 'Alabama Power Co', entity_type: 'Investor Owned' }],
    us_states: [{ fips: '01', name: 'Alabama', abbr: 'AL', geometry: { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 1], [0, 0]]] } }],
  }
  /** One account's cloud, shared by every device that signs in. */
  function fakeCloud() {
    let saved: CloudWorkspace | null = null
    let overview = ''
    let n = 0
    const datasets = new Map<string, CloudDataset>()
    const files = new Map<string, Uint8Array>()
    let v = 0
    const version = () => `2026-10-29T00:00:${String(++v).padStart(2, '0')}Z`
    const store: CloudStore = {
      datasets: async (ids) => ids.flatMap((id) => (datasets.has(id) ? [structuredClone(datasets.get(id)!)] : [])),
      putDataset: async (d, f) => {
        const updatedAt = version()
        datasets.set(d.id, { ...structuredClone(d), updatedAt, sizeBytes: f.byteLength, hasFile: true, owned: true })
        files.set(d.id, f)
        return { updatedAt }
      },
      updateDetails: async (id, patch) => {
        const updatedAt = version()
        datasets.set(id, { ...datasets.get(id)!, ...patch, updatedAt })
        return { updatedAt }
      },
      readFile: async (id) => files.get(id) ?? Promise.reject(new Error('no file')),
      deleteDataset: async (id) => void (datasets.delete(id), files.delete(id)),
      defaultWorkspace: async () => saved,
      saveDefaultWorkspace: async (w) => {
        saved = { id: saved?.id ?? 'w1', name: w.name, file: JSON.parse(JSON.stringify(w.file)), updatedAt: `2026-10-28T00:00:0${++n}Z` }
        overview = w.overview
        return { id: saved.id, updatedAt: saved.updatedAt }
      },
    }
    return { cloud: () => store, saved: () => saved?.file as WorkspaceFile, overview: () => overview, datasets }
  }
  const device = (cloud: () => CloudStore) => {
    const db = new MemoryDatabase()
    const server = createServer(db, { readBuiltin: async (t) => tables[t] ?? [], sql: nodeDuckDb, cloud, readDefaultWorkspace: async () => readFileSync('public/data/default.powergis.json', 'utf8') })
    return { db, server }
  }
  /** What the page does to save: the working copy as a document, with this device's dataset facts. */
  async function docOf(db: MemoryDatabase, file: WorkspaceFile, extra: string[] = []) {
    const records = new Map((await db.list('datasets')).map((d) => [d.id, d]))
    const workspace = { name: file.name, datasetIds: [...file.datasetIds, ...extra], transforms: file.transforms, visualizations: file.visualizations }
    return toWorkspaceFile(workspace, (id) => records.get(id))
  }

  it('refuses cloud requests until signed in', async () => {
    const { server } = device(fakeCloud().cloud)
    expect(await server.handle('cloudWorkspace', {})).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(data(await server.handle('setAuth', { accessToken: 'token' }))).toEqual({ signedIn: true })
    expect(data(await server.handle('cloudWorkspace', {}))).toEqual({ workspace: null })
    expect(data(await server.handle('setAuth', { accessToken: null }))).toEqual({ signedIn: false })
  })

  it('stores a dataset in the cloud; another device downloads it, and changes made there are saved, with conflicts caught', async () => {
    const account = fakeCloud()
    const a = device(account.cloud)
    data(await a.server.handle('setAuth', { accessToken: 't' }))
    const own = data(await a.server.handle('uploadDataset', { source: { kind: 'csv', file: file('mine.csv', 'fips,x\n01001,1\n01003,2\n') } })).datasetId
    data(await a.server.handle('storeInCloud', { id: own }))
    const onA = (await a.db.get('datasets', own))!
    expect(onA).toMatchObject({ store: 'remote', cloud: { version: account.datasets.get(own)!.updatedAt } })
    expect(account.datasets.get(own)).toMatchObject({ name: 'mine', rowCount: 2, hasFile: true })
    // Storing it again does nothing: it's the same version.
    expect(data(await a.server.handle('cloudStatus', { ids: [own] })).datasets).toEqual([{ id: own, state: 'same', updatedAt: onA.cloud!.version, sizeBytes: expect.any(Number) }])

    // Device B opens a workspace using it: downloaded, not missing; same id, same rows.
    const sent = toWorkspaceFile({ ...emptyWorkspace('W'), datasetIds: [own] }, (id) => (id === own ? onA : undefined))
    const b = device(account.cloud)
    data(await b.server.handle('setAuth', { accessToken: 't' }))
    const opened = data(await b.server.handle('openDocument', { file: sent }))
    expect(opened.missing).toEqual([])
    expect(await b.db.readRows(onA.table)).toEqual([{ fips: '01001', x: 1 }, { fips: '01003', x: 2 }])
    expect((await b.db.get('datasets', own))!.store).toBe('remote')

    // A rewrites it with a transform: changed here (not in the cloud), and saving it uploads it.
    const rewrite = (srv: typeof a.server) => srv.handle('runTransform', { transform: { id: 't', name: 'T', inputs: [{ datasetId: own, alias: 'm' }], outputs: [{ key: 'o', name: 'mine', sql: 'SELECT fips, x * 10 AS x FROM m', outputId: own }] } })
    data(await rewrite(a.server))
    expect((await a.db.get('datasets', own))!.cloud?.changed).toBe(true)
    data(await a.server.handle('storeInCloud', { id: own }))
    expect((await a.db.get('datasets', own))!.cloud?.changed).toBeUndefined()

    // B changed it too, from the old version: saving is a conflict until B overwrites; or B takes the cloud's back.
    data(await rewrite(b.server))
    expect(data(await b.server.handle('cloudStatus', { ids: [own] })).datasets[0].state).toBe('cloudNewer')
    expect(await b.server.handle('storeInCloud', { id: own })).toMatchObject({ ok: false, error: { code: 'conflict' } })
    data(await b.server.handle('fetchFromCloud', { id: own }))
    expect((await b.db.get('datasets', own))!.cloud?.changed).toBeUndefined()
    expect((await b.db.readRows(onA.table))!.map((r) => r.x)).toEqual([10, 20])
    data(await rewrite(b.server))
    data(await b.server.handle('storeInCloud', { id: own, overwrite: true }))
    expect((await b.db.get('datasets', own))!.cloud?.version).toBe(account.datasets.get(own)!.updatedAt)

    // A renames it (on Save): the cloud's name changes, and A's copy stays current.
    data(await a.server.handle('updateDataset', { id: own, name: 'Mine, renamed' }))
    expect(account.datasets.get(own)!.name).toBe('Mine, renamed')
    // A local copy is independent; deleting the cloud dataset deletes it from the cloud.
    const copy = data(await a.server.handle('copyToLocal', { id: own })).datasetId
    expect(await a.db.get('datasets', copy)).toMatchObject({ store: 'local', name: 'Mine, renamed (local copy)' })
    expect((await a.db.get('datasets', copy))!.cloud).toBeUndefined()
    data(await a.server.handle('deleteDataset', { id: own }))
    expect(account.datasets.has(own)).toBe(false)
    expect(data(await b.server.handle('cloudStatus', { ids: [own] })).datasets[0].state).toBe('gone')
  })

  it('opens a document on another device: built-ins and outputs made there, an upload reported by name', async () => {
    const account = fakeCloud()
    const a = device(account.cloud)
    data(await a.server.handle('setAuth', { accessToken: 't' }))
    const seeded = data(await a.server.handle('seedDefaultWorkspace', {})).file
    const own = data(await a.server.handle('uploadDataset', { source: { kind: 'csv', file: file('mine.csv', 'x\n1\n') } })).datasetId
    const sent = await docOf(a.db, seeded, [own])
    data(await a.server.handle('saveCloudWorkspace', { file: sent, overview: 'summary' }))
    expect(account.overview()).toBe('summary')

    // In the cloud: device A's ids, each with its facts.
    const saved = account.saved()
    expect(saved.datasets.map((d) => d.origin.kind)).toEqual(['output', 'builtin', 'builtin', 'builtin', 'builtin', 'upload'])
    expect(saved.datasets[0].sameAs).toEqual(['default-utilities-by-county'])
    expect(saved.datasets[5]).toMatchObject({ id: own, name: 'mine', rows: 1 })

    // Device B: everything is made there; the upload isn't, and is named.
    const b = device(account.cloud)
    data(await b.server.handle('setAuth', { accessToken: 't' }))
    const { workspace } = data(await b.server.handle('cloudWorkspace', {}))
    const opened = data(await b.server.handle('openDocument', { file: workspace!.file }))
    expect(opened.missing).toEqual([{ id: own, name: 'mine', rows: 1, why: 'elsewhere' }])
    expect(opened.failed).toEqual([])
    for (const id of opened.file.datasetIds.filter((id) => id !== own)) expect(await b.db.get('datasets', id)).toBeTruthy()
    expect(opened.file.transforms[0].outputs[0].outputId).toBe(opened.file.datasetIds[0])

    // Opening it again on B reuses what B made: nothing new, nothing run.
    const countB = (await b.db.list('datasets')).length
    const again = data(await b.server.handle('openDocument', { file: workspace!.file }))
    expect(again.file.datasetIds).toEqual(opened.file.datasetIds)
    expect((await b.db.list('datasets')).length).toBe(countB)

    // B saves (still pointing at A's upload); A opens B's document: A's own datasets are recognized (ids and copies), nothing new is made.
    data(await b.server.handle('saveCloudWorkspace', { file: await docOf(b.db, opened.file), overview: '' }))
    const countA = (await a.db.list('datasets')).length
    const back = data(await a.server.handle('openDocument', { file: account.saved() }))
    expect(back.file.datasetIds).toEqual([...seeded.datasetIds, own])
    expect(back.missing).toEqual([])
    expect((await a.db.list('datasets')).length).toBe(countA)
  })

  it('runs a transform again when its SQL changed elsewhere, into the same dataset', async () => {
    const a = device(fakeCloud().cloud)
    const seeded = data(await a.server.handle('seedDefaultWorkspace', {})).file
    const sent = await docOf(a.db, seeded)
    const changed = { ...sent, transforms: [{ ...sent.transforms[0], outputs: [{ ...sent.transforms[0].outputs[0], sql: 'SELECT geometry, name AS county FROM counties' }] }] }
    const count = (await a.db.list('datasets')).length
    const r = data(await a.server.handle('openDocument', { file: changed }))
    const out = (await a.db.get('datasets', r.file.datasetIds[0]))!
    expect(out.rowCount).toBe(1)
    expect(out.extensions?.sql).toBe('SELECT geometry, name AS county FROM counties')
    expect((await a.db.list('datasets')).length).toBe(count)
  })

  it("runs transforms in whatever order their inputs allow, and reports one it can't run", async () => {
    const b = device(fakeCloud().cloud)
    const t = (id: string, input: string, out: string) => ({ id, name: id, inputs: [{ datasetId: input, alias: 'x' }], outputs: [{ key: 'o1', name: id, sql: 'SELECT * FROM x', outputId: out }] })
    const fact = (id: string, origin: WorkspaceFile['datasets'][number]['origin']) => ({ id, name: id, store: 'local' as const, origin })
    const doc: WorkspaceFile = {
      format: 'powergis-workspace', version: 2, name: 'W', visualizations: [],
      datasetIds: ['o-second', 'o-first', 'o-lost'],
      // "second" reads "first"'s output; "first" reads a built-in; "lost" reads a dataset this device doesn't have.
      transforms: [t('second', 'o-first', 'o-second'), t('first', 'u', 'o-first'), t('lost', 'plants', 'o-lost')],
      datasets: [
        fact('o-second', { kind: 'output', transform: 'second', output: 'o1' }),
        fact('o-first', { kind: 'output', transform: 'first', output: 'o1' }),
        fact('o-lost', { kind: 'output', transform: 'lost', output: 'o1' }),
        fact('u', { kind: 'builtin', table: 'utilities' }),
        fact('plants', { kind: 'upload', source: 'Device · plants.csv' }),
      ],
    }
    const r = data(await b.server.handle('openDocument', { file: doc }))
    expect(r.file.datasetIds.slice(0, 2).every((id) => !['o-second', 'o-first'].includes(id))).toBe(true)
    expect(r.missing.map((m) => [m.name, m.why])).toEqual([['plants', 'elsewhere'], ['o-lost', 'output']])
    expect(r.failed).toEqual([{ name: 'lost', reason: "an input dataset isn't on this device" }])
  })

  it('opens version 1 documents (cloud copies saved before version 2)', async () => {
    const b = device(fakeCloud().cloud)
    const v1 = { format: 'powergis-workspace', version: 1, exportedAt: '', name: 'Old', datasetIds: ['builtin:utilities', 'gone'], names: { gone: 'plants' }, visualizations: [] }
    const r = data(await b.server.handle('openDocument', { file: v1 }))
    expect(await b.db.get('datasets', r.file.datasetIds[0])).toMatchObject({ extensions: { builtin: 'utilities' } })
    expect(r.missing).toEqual([{ id: 'gone', name: 'plants', why: 'unknown' }])
  })
})

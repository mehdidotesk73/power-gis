import { describe, expect, it } from 'vitest'
import { runTool, workspaceVersion, type AgentHost } from './tools'
import { runAgent } from './loop'
import type { ChatSession, TurnInput, TurnResult } from './provider'
import { emptyWorkspace, type WorkspaceDoc } from '../workspace/workspace'
import type { DatasetRecord } from '../../shared/records'
import type { ColumnInfo } from '../dataset/columns'

const t0 = '2026-01-01T00:00:00.000Z'
const record = (id: string, columns: ColumnInfo[], store: 'local' | 'remote' = 'local'): DatasetRecord => ({
  id,
  name: id.toUpperCase(),
  table: `ds_${id}`,
  columns,
  rowCount: 10,
  origin: 'Device · test.csv',
  store,
  createdAt: t0,
  updatedAt: t0,
})

function fakeHost(doc: WorkspaceDoc = emptyWorkspace('Test')) {
  const datasets = new Map<string, DatasetRecord>([
    ['prices', record('prices', [{ name: 'fips', type: 'string' }, { name: 'price', type: 'double' }, { name: 'month', type: 'datetime' }])],
    ['counties', record('counties', [{ name: 'fips', type: 'string' }, { name: 'name', type: 'string' }, { name: 'geometry', type: 'region' }])],
    ['joined', record('joined', [{ name: 'name', type: 'string' }, { name: 'price', type: 'double' }, { name: 'geometry', type: 'region' }])],
    ['shared', record('shared', [{ name: 'x', type: 'int' }], 'remote')],
  ])
  const calls: string[] = []
  const state = { doc }
  const host: AgentHost = {
    doc: () => state.doc,
    setDoc: (d) => void (state.doc = d),
    dataset: async (id) => datasets.get(id),
    listDatasets: async () => [...datasets.values()],
    query: async (sql) =>
      /nope/.test(sql)
        ? { ok: false, error: { code: 'invalid', message: 'Binder Error: no column nope' } }
        : { ok: true, data: { columns: [{ name: 'n', type: 'int' }, { name: 'geometry', type: 'region' }], rows: [{ n: 3, geometry: '{"type":"Polygon","coordinates":[]}' }], rowCount: 3 } },
    shape: async (id, binding) => {
      const d = datasets.get(id)!
      const g = d.columns.find((c) => c.name === binding.column)
      if (!g || !['region', 'point', 'polyline'].includes(g.type)) return `"${binding.column}" is not a geometry column`
      return { columns: d.columns.filter((c) => c.name !== binding.column && c.name !== binding.label), maxRowsPerFeature: 1, geometryKind: 'region', features: 10, matchedRows: 10, unmatched: 0, unmatchedSamples: [] }
    },
    runTransform: async (id) => (calls.push(`run ${id}`), { ok: true, outputs: [{ datasetId: 'joined', name: 'JOINED', rowCount: 10, created: false }] }),
    deleteDataset: async (id) => (calls.push(`delete ${id}`), { ok: true }),
    updateDataset: async (id, patch) => (calls.push(`update ${id} ${JSON.stringify(patch)}`), { ok: true }),
    values: async () => ({
      geometryKind: 'region',
      valueType: 'double',
      unmatched: 0,
      unmatchedSamples: [],
      features: [0, 1, 10, 100, 1000, 10000, null].map((value, i) => ({ key: `f${i}`, label: `F${i}`, rows: 1, value, geometry: { type: 'Point', coordinates: [0, 0] } })),
    }),
    ask: async (question, details) => (calls.push(`ask ${question}${details ? ` | ${details}` : ''}`), { answer: 'reject', notes: 'Use 2024 only' }),
  }
  return { host, state, calls }
}
const json = (s: string) => JSON.parse(s)

describe('agent tools', () => {
  it('lists every dataset the user can use, and reads the workspace config with a version', async () => {
    const { host } = fakeHost({ ...emptyWorkspace('Test'), datasetIds: ['prices'] })
    const list = await runTool(host, 'list_datasets', {})
    expect(list.summary).toBe('4 datasets (3 local)')
    expect(json(list.content).map((d: { id: string; store: string; inWorkspace: boolean }) => [d.id, d.store, d.inWorkspace])).toEqual([
      ['prices', 'local', true],
      ['counties', 'local', false],
      ['joined', 'local', false],
      ['shared', 'remote', false],
    ])
    expect(json(list.content)[0]).not.toHaveProperty('columns')
    const w = json((await runTool(host, 'get_workspace', {})).content)
    expect(w).toMatchObject({ version: workspaceVersion(host.doc()), name: 'Test', datasets: [{ id: 'prices', name: 'PRICES', store: 'local', rows: 10 }], transforms: [], visualizations: [] })
    expect(w.datasets[0]).not.toHaveProperty('columns')
  })

  it('reports the drawn values so the agent can pick a scale, and accepts a fixed domain', async () => {
    const { host, state } = fakeHost()
    const viz = (color: object) => ({
      version: workspaceVersion(state.doc),
      datasetIds: ['joined'],
      transforms: [],
      visualizations: [{ id: 'v1', name: 'Price', datasetId: 'joined', geometry: 'geometry', column: 'price', color }],
    })
    expect((await runTool(host, 'update_workspace', viz({ kind: 'colormap', colormap: 'rdBu', domain: [-5, 5] }))).isError).toBe(false)
    expect(state.doc.visualizations[0].style.color).toMatchObject({ kind: 'colormap', colormap: 'rdBu', domain: [-5, 5] })
    expect(await runTool(host, 'update_workspace', viz({ kind: 'colormap', scale: 'log', domain: [0, 5] }))).toMatchObject({ isError: true, content: expect.stringContaining('positive on a log scale') })
    expect(await runTool(host, 'update_workspace', viz({ kind: 'colormap', domain: [5, 1] }))).toMatchObject({ isError: true })
    const stats = json((await runTool(host, 'visualization_stats', { id: 'v1' })).content)
    expect(stats).toMatchObject({ visualization: 'Price', features: 7, withValue: 6, nulls: 1, min: 0, max: 10000, atOrBelowZero: 1, belowZero: 0, positiveOrdersOfMagnitude: 4, color: { colormap: 'rdBu', domain: [-5, 5] } })
    expect(await runTool(host, 'visualization_stats', { id: 'nope' })).toMatchObject({ isError: true })
  })

  it('renames and describes local datasets only', async () => {
    const { host, calls } = fakeHost()
    expect((await runTool(host, 'update_dataset', { id: 'prices', name: ' Home prices ', description: 'Zillow ZHVI by county' })).summary).toBe('renamed “PRICES” → “Home prices”')
    expect(await runTool(host, 'update_dataset', { id: 'shared', name: 'x' })).toMatchObject({ isError: true, summary: 'refused: remote dataset' })
    expect(await runTool(host, 'update_dataset', { id: 'prices' })).toMatchObject({ isError: true })
    expect(await runTool(host, 'update_dataset', { id: 'prices', name: '  ' })).toMatchObject({ isError: true })
    expect(calls).toEqual(['update prices {"name":"Home prices","description":"Zillow ZHVI by county"}'])
  })

  it('asks the user and hands the answer and notes back', async () => {
    const { host, calls } = fakeHost()
    const out = await runTool(host, 'ask_user', { question: 'Build this?', details: 'Join prices onto counties' })
    expect(json(out.content)).toEqual({ answer: 'reject', notes: 'Use 2024 only' })
    expect(out.summary).toBe('rejected · “Use 2024 only”')
    expect(calls).toEqual(['ask Build this? | Join prices onto counties'])
    expect(await runTool(host, 'ask_user', {})).toMatchObject({ isError: true })
  })

  it('queries any dataset, hides geometry, and reports SQL errors to the model', async () => {
    const { host } = fakeHost()
    const out = await runTool(host, 'query_sql', { sql: 'SELECT 1', inputs: [{ datasetId: 'shared', alias: 's' }] })
    expect(json(out.content)).toMatchObject({ rowCount: 3, rows: [{ n: 3, geometry: '<region>' }] })
    expect(await runTool(host, 'query_sql', { sql: 'SELECT nope', inputs: [] })).toMatchObject({ isError: true, content: expect.stringContaining('Binder Error') })
    expect(await runTool(host, 'query_sql', { sql: 'SELECT 1', inputs: [{ datasetId: 'zz', alias: 'z' }] })).toMatchObject({ isError: true })
    expect(await runTool(host, 'query_sql', { inputs: [] })).toMatchObject({ isError: true, summary: 'invalid input' })
  })

  it('builds a workspace: datasets, a transform and a visualization with defaults and a color', async () => {
    const { host, state } = fakeHost()
    const out = await runTool(host, 'update_workspace', {
      version: workspaceVersion(host.doc()),
      datasetIds: ['prices', 'counties', 'joined'],
      transforms: [{ name: 'Join', inputs: [{ datasetId: 'prices', alias: 'p' }, { datasetId: 'counties', alias: 'c' }], outputs: [{ name: 'Joined', sql: 'SELECT …', outputId: 'joined' }] }],
      visualizations: [{ name: 'Price', datasetId: 'joined', geometry: 'geometry', label: 'name', column: 'price', color: { kind: 'colormap', colormap: 'magma' } }],
    })
    expect(out.isError).toBe(false)
    expect(json(out.content).version).toBe(workspaceVersion(state.doc))
    expect(state.doc.transforms[0]).toMatchObject({ name: 'Join', outputs: [{ name: 'Joined', outputId: 'joined' }] })
    const v = state.doc.visualizations[0]
    expect(v).toMatchObject({ kind: 'scalar', name: 'Price', column: 'price', aggregation: 'first', binding: { column: 'geometry', label: 'name' } })
    expect(v.style.color).toMatchObject({ kind: 'colormap', colormap: 'magma' })

    // Keeping a visualization by id keeps its style; the stamp must be current.
    const again = { version: workspaceVersion(state.doc), datasetIds: ['prices', 'counties', 'joined'], transforms: [{ ...state.doc.transforms[0] }], visualizations: [{ id: v.id, name: 'Price (latest)', datasetId: 'joined', geometry: 'geometry', label: 'name', column: 'price' }] }
    expect((await runTool(host, 'update_workspace', again)).isError).toBe(false)
    expect(state.doc.visualizations[0]).toMatchObject({ id: v.id, name: 'Price (latest)', style: { color: { colormap: 'magma' } } })
    expect(await runTool(host, 'update_workspace', again)).toMatchObject({ isError: true, summary: 'workspace changed: re-read' })
  })

  it('refuses the whole update, listing every problem, and changes nothing', async () => {
    const before = { ...emptyWorkspace('Test'), datasetIds: ['prices'] }
    const { host, state } = fakeHost(before)
    const out = await runTool(host, 'update_workspace', {
      version: workspaceVersion(before),
      datasetIds: ['prices', 'counties', 'shared', 'ghost'],
      transforms: [{ name: 'Bad', inputs: [{ datasetId: 'prices', alias: 'p' }], outputs: [{ name: 'Out', sql: 'SELECT 1', outputId: 'shared' }] }],
      visualizations: [
        { name: 'A', datasetId: 'prices', geometry: 'fips', column: 'price' },
        { name: 'B', datasetId: 'counties', geometry: 'geometry', column: 'nope' },
        { name: 'C', datasetId: 'counties', geometry: 'geometry', column: 'name', aggregation: 'sum' },
        { name: 'D', datasetId: 'counties', geometry: 'geometry', column: 'name', color: { kind: 'colormap', colormap: 'rainbow' } },
      ],
    })
    expect(out.isError).toBe(true)
    for (const bit of ['no dataset "ghost"', 'remote dataset', 'not a geometry column', '"nope" isn\'t a value column', "sum doesn't apply", 'colormap must be one of']) expect(out.content).toContain(bit)
    expect(state.doc).toBe(before)
  })

  it('runs transforms and deletes datasets only when they are local', async () => {
    const doc: WorkspaceDoc = {
      ...emptyWorkspace('Test'),
      datasetIds: ['prices', 'shared', 'joined'],
      transforms: [
        { id: 't1', name: 'Local', inputs: [{ datasetId: 'shared', alias: 's' }], outputs: [{ key: 'o', name: 'Out', sql: 'SELECT 1', outputId: 'joined' }] },
        { id: 't2', name: 'Remote out', inputs: [{ datasetId: 'prices', alias: 'p' }], outputs: [{ key: 'o', name: 'Out', sql: 'SELECT 1', outputId: 'shared' }] },
      ],
    }
    const { host, calls } = fakeHost(doc)
    expect((await runTool(host, 'run_transform', { id: 't1' })).summary).toBe('10 rows → JOINED')
    expect(await runTool(host, 'run_transform', { id: 't2' })).toMatchObject({ isError: true, summary: 'refused: remote output' })
    expect(await runTool(host, 'delete_dataset', { id: 'shared' })).toMatchObject({ isError: true, summary: 'refused: remote dataset' })
    expect(await runTool(host, 'delete_dataset', { id: 'prices' })).toMatchObject({ isError: true, summary: 'refused: still used' })
    expect((await runTool(host, 'delete_dataset', { id: 'joined' })).isError).toBe(false)
    expect(calls).toEqual(['run t1', 'delete joined'])
    expect(await runTool(host, 'drop_everything', {})).toMatchObject({ isError: true })
  })
})

describe('agent loop', () => {
  /** A scripted model: each send returns the next turn. */
  function scripted(turns: Omit<TurnResult, 'usage'>[]) {
    const inputs: TurnInput[] = []
    const session: ChatSession = {
      async send(input, events) {
        inputs.push(input)
        const t = turns.shift()!
        if (t.text) events.onText?.(t.text)
        return { ...t, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }
      },
    }
    return { session, inputs }
  }

  it('runs the tools the model asks for and sends their results back until it answers', async () => {
    const { session, inputs } = scripted([
      { text: '', stop: 'tools', toolCalls: [{ id: 'a', name: 'get_workspace', input: {} }, { id: 'b', name: 'query_sql', input: {} }] },
      { text: 'Done.', stop: 'done', toolCalls: [] },
    ])
    const seen: string[] = []
    const r = await runAgent(session, async (name) => ({ content: `${name} ok`, isError: name === 'query_sql', summary: '' }), 'hi', { onToolEnd: (c) => seen.push(c.name), onText: (t) => seen.push(t) })
    expect(r).toEqual({ end: 'done', usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 } })
    expect(seen).toEqual(['get_workspace', 'query_sql', 'Done.'])
    expect(inputs[1]).toEqual({ toolResults: [{ id: 'a', content: 'get_workspace ok', isError: false }, { id: 'b', content: 'query_sql ok', isError: true }] })
  })

  it('stops at once even while a tool or the model hangs', async () => {
    const never = new Promise<never>(() => {})
    const ctl = new AbortController()
    const { session } = scripted([{ text: '', stop: 'tools', toolCalls: [{ id: 'a', name: 'slow', input: {} }] }])
    const run = runAgent(session, () => (setTimeout(() => ctl.abort(), 5), never), 'hi', {}, ctl.signal)
    expect((await run).end).toBe('stopped')
    const ctl2 = new AbortController()
    const hung: ChatSession = { send: () => never }
    const run2 = runAgent(hung, async () => ({ content: '', isError: false, summary: '' }), 'hi', {}, ctl2.signal)
    setTimeout(() => ctl2.abort(), 5)
    expect((await run2).end).toBe('stopped')
  })

  it('stops when asked, and at the step limit', async () => {
    const ctl = new AbortController()
    const { session } = scripted([{ text: '', stop: 'tools', toolCalls: [{ id: 'a', name: 'x', input: {} }] }])
    const r = await runAgent(session, async () => (ctl.abort(), { content: '', isError: false, summary: '' }), 'hi', {}, ctl.signal)
    expect(r.end).toBe('stopped')
    const forever: ChatSession = { send: async () => ({ text: '', stop: 'tools', toolCalls: [{ id: 'a', name: 'x', input: {} }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) }
    expect((await runAgent(forever, async () => ({ content: '', isError: false, summary: '' }), 'hi')).end).toBe('step-limit')
  })
})

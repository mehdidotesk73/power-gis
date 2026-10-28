import { describe, expect, it } from 'vitest'
import { runTool, workspaceVersion, type AgentHost } from './tools'
import { runAgent } from './loop'
import { EDITOR_TOOL } from './workspaceFiles'
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
    record: (id) => datasets.get(id),
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
    updateDataset: (id, patch) => (calls.push(`update ${id} ${JSON.stringify(patch)}`), { ok: true }),
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

const edit = (host: AgentHost, input: object) => runTool(host, EDITOR_TOOL, input)

/** Writes the given files (paths without the leading slash) and the index, then applies. */
async function writeAndApply(host: AgentHost, index: object, files: Record<string, string | object>, dryRun?: boolean) {
  await runTool(host, 'get_workspace', {})
  for (const [path, body] of Object.entries(files)) {
    const out = await edit(host, { command: 'create', path: `/${path}`, file_text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) })
    expect(out.isError, out.content).toBe(false)
  }
  await edit(host, { command: 'create', path: '/workspace.json', file_text: JSON.stringify({ name: 'Test', ...index }, null, 2) })
  return runTool(host, 'apply_workspace', dryRun ? { dryRun } : {})
}

describe('agent tools', () => {
  it('lists every dataset the user can use, and starts from an overview of the workspace files', async () => {
    const { host } = fakeHost({ ...emptyWorkspace('Test'), datasetIds: ['prices'] })
    const list = await runTool(host, 'list_datasets', {})
    expect(list.summary).toBe('4 datasets (3 local)')
    expect(json(list.content).map((d: { id: string; store: string; inWorkspace: boolean }) => [d.id, d.store, d.inWorkspace])).toEqual([
      ['prices', 'local', true],
      ['counties', 'local', false],
      ['joined', 'local', false],
      ['shared', 'cloud', false],
    ])
    expect(json(list.content)[0]).not.toHaveProperty('columns')
    const w = (await runTool(host, 'get_workspace', {})).content
    expect(w).toContain(`version ${workspaceVersion(host.doc())}`)
    expect(w).toContain('- prices  "PRICES"  local · 10 rows · Device · test.csv')
    expect(w).toContain('Files: /datasets.json · /workspace.json')
    expect((await edit(host, { command: 'view', path: '/' })).content).toBe('Files in /:\n/datasets.json\n/overview.md\n/workspace.json')
    expect((await edit(host, { command: 'view', path: '/workspace.json' })).content).toContain('     3\t  "datasetIds": [')
  })

  it('reports the drawn values so the agent can pick a scale, and accepts a fixed domain', async () => {
    const { host, state } = fakeHost()
    const viz = (color: object) => writeAndApply(host, { datasetIds: ['joined'], transforms: [], visualizations: ['price'] }, { 'visualizations/price.json': { name: 'Price', datasetId: 'joined', geometry: 'geometry', column: 'price', color } })
    expect((await viz({ kind: 'colormap', colormap: 'rdBu', domain: [-5, 5] })).isError).toBe(false)
    expect(state.doc.visualizations[0].style.color).toMatchObject({ kind: 'colormap', colormap: 'rdBu', domain: [-5, 5] })
    state.doc = { ...state.doc, visualizations: [] }
    expect(await viz({ kind: 'colormap', scale: 'log', domain: [0, 5] })).toMatchObject({ isError: true, content: expect.stringContaining('positive on a log scale') })
    expect(await viz({ kind: 'colormap', domain: [5, 1] })).toMatchObject({ isError: true })
    state.doc = { ...state.doc, visualizations: [] }
    await viz({ kind: 'colormap', colormap: 'rdBu', domain: [-5, 5] })
    const id = state.doc.visualizations[0].id
    const stats = json((await runTool(host, 'visualization_stats', { id })).content)
    expect(stats).toMatchObject({ visualization: 'Price', features: 7, withValue: 6, nulls: 1, min: 0, max: 10000, atOrBelowZero: 1, belowZero: 0, positiveOrdersOfMagnitude: 4, color: { colormap: 'rdBu', domain: [-5, 5] } })
    expect(await runTool(host, 'visualization_stats', { id: 'nope' })).toMatchObject({ isError: true })
  })

  it('renames and describes local datasets in /datasets.json (store, rows, origin read-only; cloud ones refused)', async () => {
    const { host, calls } = fakeHost({ ...emptyWorkspace('Test'), datasetIds: ['prices', 'shared'] })
    await runTool(host, 'get_workspace', {})
    const files = JSON.parse((await edit(host, { command: 'view', path: '/datasets.json' })).content.replace(/^\s*\d+\t/gm, ''))
    expect(files.prices).toEqual({ name: 'PRICES', description: '', store: 'local', rows: 10, origin: 'Device · test.csv' })
    expect(files.shared.store).toBe('cloud')
    const write = (o: object) => edit(host, { command: 'create', path: '/datasets.json', file_text: JSON.stringify(o) })
    await write({ ...files, prices: { ...files.prices, rows: 11 } })
    expect((await runTool(host, 'apply_workspace', {})).content).toMatch(/"rows" is read-only/)
    await write({ ...files, shared: { ...files.shared, name: 'x' } })
    expect((await runTool(host, 'apply_workspace', {})).content).toMatch(/only the user can rename/)
    await write({ ...files, prices: { ...files.prices, name: 'Home prices', description: 'Zillow ZHVI by county' } })
    const r = await runTool(host, 'apply_workspace', {})
    expect(r.summary).toBe('renamed dataset “PRICES” → “Home prices” (and its description)')
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

  it('builds a workspace from files, returns the new ids, then edits it surgically', async () => {
    const { host, state, calls } = fakeHost()
    const sql = `SELECT c.geometry, c.name, p.price\nFROM p JOIN c USING (fips)\nWHERE c.name <> 'O''Brien' AND p.month = "2026-08-31"`
    const built = await writeAndApply(
      host,
      { datasetIds: ['prices', 'counties', 'joined'], transforms: ['join'], visualizations: ['price'] },
      {
        'transforms/join.json': { name: 'Join', inputs: [{ datasetId: 'prices', alias: 'p' }, { datasetId: 'counties', alias: 'c' }], outputs: [{ key: 'o1', name: 'Joined', outputId: 'joined' }] },
        'transforms/join.o1.sql': `${sql}\n`,
        'visualizations/price.json': { name: 'Price', datasetId: 'joined', geometry: 'geometry', label: 'name', column: 'price', color: { kind: 'colormap', colormap: 'magma' } },
      },
    )
    expect(built.isError, built.content).toBe(false)
    const out = json(built.content)
    const t = state.doc.transforms[0]
    const v = state.doc.visualizations[0]
    expect(out.changed).toEqual(['datasets added: prices, counties, joined', 'transform added: "Join"', 'visualization added: "Price"'])
    expect(out.added).toEqual([
      { kind: 'transform', id: t.id, from: 'join', name: 'Join' },
      { kind: 'visualization', id: v.id, from: 'price', name: 'Price' },
    ])
    // The SQL arrived exactly as written: quotes and line breaks untouched.
    expect(t.outputs[0]).toMatchObject({ key: 'o1', name: 'Joined', outputId: 'joined', sql })
    expect(v).toMatchObject({ kind: 'scalar', name: 'Price', column: 'price', aggregation: 'first', binding: { column: 'geometry', label: 'name' } })

    expect(out.renamed).toEqual({
      '/transforms/join.json': `/transforms/${t.id}.json`,
      '/transforms/join.o1.sql': `/transforms/${t.id}.o1.sql`,
      '/visualizations/price.json': `/visualizations/${v.id}.json`,
    })
    // Editing a file by its old name says where it went.
    expect(await edit(host, { command: 'view', path: '/visualizations/price.json' })).toMatchObject({ isError: true, content: expect.stringContaining(`its file is now /visualizations/${v.id}.json`) })
    // The files are rebuilt under the real ids; the overview lists them.
    const overview = (await edit(host, { command: 'view', path: '/overview.md' })).content
    expect(overview).toContain(`- ${t.id}  "Join"`)
    expect(overview).toContain(`output o1: "Joined" → joined (JOINED)  (SQL: /transforms/${t.id}.o1.sql, 3 lines)`)
    expect((await edit(host, { command: 'view', path: `/transforms/${t.id}.o1.sql` })).content).toContain("     3\tWHERE c.name <> 'O''Brien'")

    // Small edits: one inside the SQL file, one in the visualization; the style details stay.
    const style = v.style
    expect((await edit(host, { command: 'str_replace', path: `/transforms/${t.id}.o1.sql`, old_str: '"2026-08-31"', new_str: '"2026-09-30"' })).isError).toBe(false)
    expect((await edit(host, { command: 'str_replace', path: `/visualizations/${v.id}.json`, old_str: '"name": "Price",', new_str: '"name": "Price (Sept)",' })).isError).toBe(false)
    // Pending edits block tools that change the draft, and show in the overview.
    expect(await runTool(host, 'run_transform', { id: t.id })).toMatchObject({ isError: true, summary: 'refused: edits not applied' })
    expect((await edit(host, { command: 'view', path: '/overview.md' })).content).toContain('edits not applied yet')
    const dry = await runTool(host, 'apply_workspace', { dryRun: true })
    expect(json(dry.content)).toEqual({ dryRun: true, wouldChange: ['transform changed: "Join"', 'visualization changed: "Price (Sept)"'] })
    const applied = await runTool(host, 'apply_workspace', {})
    expect(json(applied.content).changed).toEqual(['transform changed: "Join"', 'visualization changed: "Price (Sept)"'])
    expect(state.doc.transforms[0].outputs[0].sql).toBe(sql.replace('2026-08-31', '2026-09-30'))
    expect(state.doc.visualizations[0]).toMatchObject({ id: v.id, name: 'Price (Sept)', style })
    expect((await runTool(host, 'run_transform', { id: t.id })).isError).toBe(false)
    expect(calls).toEqual([`run ${t.id}`])

    // An untouched workspace has nothing to apply; edits on an old version are refused.
    expect(await runTool(host, 'apply_workspace', {})).toMatchObject({ isError: true, summary: 'nothing to apply' })
    await edit(host, { command: 'str_replace', path: '/workspace.json', old_str: '"name": "Test"', new_str: '"name": "Renamed"' })
    state.doc = { ...state.doc, name: 'The user renamed it' }
    expect(await runTool(host, 'apply_workspace', {})).toMatchObject({ isError: true, summary: 'workspace changed: re-read' })
    expect((await runTool(host, 'get_workspace', {})).content).toContain('have been discarded')
  })

  it('edits only the workspace files, the way the text editor does', async () => {
    const { host } = fakeHost()
    await runTool(host, 'get_workspace', {})
    expect(await edit(host, { command: 'create', path: '/notes.txt', file_text: 'x' })).toMatchObject({ isError: true, content: expect.stringContaining("Can't create /notes.txt") })
    expect(await edit(host, { command: 'create', path: '/overview.md', file_text: 'x' })).toMatchObject({ isError: true, content: expect.stringContaining('generated') })
    expect(await edit(host, { command: 'view', path: '/../etc' })).toMatchObject({ isError: true })
    expect(await edit(host, { command: 'str_replace', path: '/workspace.json', old_str: 'nope', new_str: 'x' })).toMatchObject({ isError: true, content: expect.stringContaining('did not appear verbatim') })
    expect(await edit(host, { command: 'str_replace', path: '/workspace.json', old_str: '[]', new_str: 'x' })).toMatchObject({ isError: true, content: expect.stringContaining('occurs 3 times') })
    expect((await edit(host, { command: 'insert', path: '/workspace.json', insert_line: 1, insert_text: '  "x": 1,' })).isError).toBe(false)
    expect((await edit(host, { command: 'view', path: '/workspace.json', view_range: [1, 2] })).content).toBe('     1\t{\n     2\t  "x": 1,')
    expect(await edit(host, { command: 'delete', path: '/workspace.json' })).toMatchObject({ isError: true })


    // A SQL file off the naming pattern is refused with the rule and only facts from the files.
    const off = await edit(host, { command: 'create', path: '/transforms/county_home_income.sql', file_text: 'SELECT 1' })
    expect(off.content).toContain('named <transform>.<output key>.sql')
    expect(off.content).toContain('There is no /transforms/county_home_income.json')
    expect(off.content).not.toContain('o1')
    await edit(host, { command: 'create', path: '/transforms/t.json', file_text: JSON.stringify({ name: 'T', inputs: [], outputs: [{ key: 'a3f9', name: 'A' }, { key: 'b2', name: 'B' }] }) })
    expect((await edit(host, { command: 'create', path: '/transforms/t.sql', file_text: 'SELECT 1' })).content).toContain('/transforms/t.json has output keys "a3f9", "b2": /transforms/t.a3f9.sql, /transforms/t.b2.sql.')
    expect((await edit(host, { command: 'view', path: '/transforms/t.o1.sql' })).content).toContain('output keys "a3f9", "b2"')
    // A SQL file may come before its transform's JSON.
    expect((await edit(host, { command: 'create', path: '/transforms/later.o1.sql', file_text: 'SELECT 1' })).isError).toBe(false)
    // The overview starts with how the files work.
    expect((await runTool(host, 'get_workspace', {})).content).toContain('## How these files work')
  })

  it('refuses the whole apply, listing every problem with its file, and changes nothing', async () => {
    const before = { ...emptyWorkspace('Test'), datasetIds: ['prices'] }
    const { host, state } = fakeHost(before)
    const out = await writeAndApply(
      host,
      { datasetIds: ['prices', 'counties', 'shared', 'ghost'], transforms: ['bad'], visualizations: ['a', 'b', 'c', 'd'] },
      {
        'transforms/bad.json': { name: 'Bad', inputs: [{ datasetId: 'prices', alias: 'p' }], outputs: [{ key: 'o1', name: 'Out', outputId: 'shared' }] },
        'transforms/bad.o1.sql': 'SELECT 1',
        'visualizations/a.json': { name: 'A', datasetId: 'prices', geometry: 'fips', column: 'price' },
        'visualizations/b.json': { name: 'B', datasetId: 'counties', geometry: 'geometry', column: 'nope' },
        'visualizations/c.json': { name: 'C', datasetId: 'counties', geometry: 'geometry', column: 'name', aggregation: 'sum' },
        'visualizations/d.json': { name: 'D', datasetId: 'counties', geometry: 'geometry', column: 'name', color: { kind: 'colormap', colormap: 'rainbow' } },
      },
    )
    expect(out.isError).toBe(true)
    for (const bit of ['no dataset "ghost"', 'cloud dataset', 'not a geometry column', '"nope" isn\'t a value column', "sum doesn't apply", 'colormap must be one of']) expect(out.content).toContain(bit)
    expect(state.doc).toBe(before)

    // File-level problems: SQL inside JSON, a missing SQL file, broken JSON, an unknown field.
    const files = await writeAndApply(
      host,
      { datasetIds: ['prices'], transforms: ['t'], visualizations: ['v', 'w'] },
      {
        'transforms/t.json': { name: 'T', inputs: [{ datasetId: 'prices', alias: 'p' }], outputs: [{ key: 'o1', name: 'Out', sql: 'SELECT 1' }] },
        'visualizations/v.json': '{ "name": "V", }',
        'visualizations/w.json': { name: 'W', datasetId: 'prices', geometry: 'g', column: 'price', colour: 'red' },
      },
    )
    for (const bit of ["SQL doesn't go in the JSON", 'its SQL file /transforms/t.o1.sql is missing', "/visualizations/v.json isn't valid JSON", 'unknown field "colour"']) expect(files.content).toContain(bit)
    expect(state.doc).toBe(before)
  })

  it('reports files nothing uses, and keeps items whose files were not touched exactly', async () => {
    const { host, state } = fakeHost()
    await writeAndApply(host, { datasetIds: ['joined'], transforms: [], visualizations: ['price'] }, { 'visualizations/price.json': { name: 'Price', datasetId: 'joined', geometry: 'geometry', column: 'price' } })
    const before = state.doc
    await runTool(host, 'get_workspace', {})
    await edit(host, { command: 'create', path: '/transforms/spare.o1.sql', file_text: 'SELECT 1' })
    await edit(host, { command: 'str_replace', path: '/workspace.json', old_str: '"name": "Test"', new_str: '"name": "Renamed"' })
    const out = json((await runTool(host, 'apply_workspace', {})).content)
    expect(out).toMatchObject({ changed: ['name → "Renamed"'], unusedFiles: expect.stringContaining('/transforms/spare.o1.sql') })
    expect(state.doc.visualizations).toEqual(before.visualizations)
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
    expect(await runTool(host, 'run_transform', { id: 't2' })).toMatchObject({ isError: true, summary: 'refused: cloud output' })
    expect(await runTool(host, 'delete_dataset', { id: 'shared' })).toMatchObject({ isError: true, summary: 'refused: cloud dataset' })
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

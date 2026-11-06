import { describe, expect, it } from 'vitest'
import { documentFiles } from '../workspace/files'
import { toWorkspaceFile } from '../workspace/file'
import { cardAnswer, initialState, NEITHER, type Card, type QuestionState } from './form'

/** Answers a card as a user would: change its state, press a button (default: the first). */
const answering = (fn: (card: Card, s: Record<string, QuestionState>) => string | void, comments = '') => async (card: Card) => {
  const s = initialState(card)
  const button = fn(card, s) || card.buttons[0]
  return cardAnswer(card, s, button, comments)
}
import { briefWithNeeds, forgetChat, notDescribed, runTool, TOOLS, webFileDescription, workspaceVersion, type AgentHost } from './tools'
import { USER_NOTES } from './exchanges'
import { runAgent } from './loop'
import { EDITOR_TOOL } from './workspaceFiles'
import type { ChatSession, TurnInput, TurnResult } from './provider'
import { emptyWorkspace, type WorkspaceDoc } from '../workspace/workspace'
import type { DatasetRecord } from '../../shared/records'
import type { ColumnInfo } from '../dataset/columns'

const t0 = '2026-01-01T00:00:00.000Z'
const record = (id: string, columns: ColumnInfo[], store: 'local' | 'remote' = 'local'): DatasetRecord => ({
  ...(store === 'remote' ? { link: { cloudId: id, version: 'v1' } } : {}),
  id,
  name: id.toUpperCase(),
  table: `ds_${id}`,
  columns,
  rowCount: 10,
  origin: 'Device · test.csv',
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
    ask: async (card) => (calls.push(`ask ${card.title}${card.context ? ` | ${card.context}` : ''}`), cardAnswer(card, initialState(card), card.buttons[1], 'Use 2024 only')),
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
    expect(w).toContain('Files: /about.md · /datasets.json · /workspace.json')
    expect((await edit(host, { command: 'view', path: '/' })).content).toBe('Files in /:\n/about.md\n/datasets.json\n/overview.md\n/workspace.json')
    expect((await edit(host, { command: 'view', path: '/workspace.json' })).content).toContain('     3\t  "datasetIds": [')
  })

  it('reports the drawn values so the agent can pick a scale, and accepts a fixed domain', async () => {
    const { host, state } = fakeHost()
    const viz = (color: object) => writeAndApply(host, { datasetIds: ['joined'], transforms: [], visualizations: ['price'] }, { 'visualizations/price.json': { name: 'Price', datasetId: 'joined', binding: { kind: 'geometry', column: 'geometry' }, column: 'price', style: { color } } })
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

  it('edits every visualization setting, checked: pattern, opacity by value, outline, size; the file is the zip\'s', async () => {
    const { host, state } = fakeHost()
    await writeAndApply(host, { datasetIds: ['joined'], transforms: [], visualizations: ['price'] }, { 'visualizations/price.json': { name: 'Price', datasetId: 'joined', binding: { kind: 'geometry', column: 'geometry' }, column: 'price' } })
    const v = state.doc.visualizations[0]
    // The agent's file holds every setting, exactly as a downloaded zip does.
    await runTool(host, 'get_workspace', {})
    const text = (await edit(host, { command: 'view', path: `/visualizations/${v.id}.json` })).content.replace(/^\s*\d+\t/gm, '')
    const { id: _id, ...settings } = v
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(settings)))
    expect(documentFiles(toWorkspaceFile(state.doc, () => undefined)).get(`visualizations/${v.id}.json`)).toBe(`${JSON.stringify(settings, null, 2)}\n`)

    const style = {
      opacity: { kind: 'field', field: 'anything', range: [0.2, 0.9] },
      pattern: { kind: 'field', patterns: { '10': 'hatch' }, color: '#ffffff' },
      outline: { color: '#000000', width: 1.5 },
      size: 4,
    }
    const applied = await writeAndApply(host, { datasetIds: ['joined'], transforms: [], visualizations: [v.id] }, { [`visualizations/${v.id}.json`]: { ...settings, style: { ...settings.style, ...style } } })
    expect(applied.isError, applied.content).toBe(false)
    expect(state.doc.visualizations[0].style).toMatchObject({
      color: v.style.color,
      opacity: { kind: 'field', field: '_value', range: [0.2, 0.9] }, // the field is always the drawn value
      pattern: { kind: 'field', field: '_value', patterns: { '10': 'hatch' }, color: '#ffffff' },
      outline: { color: '#000000', width: 1.5 },
      size: 4,
    })

    const bad = await writeAndApply(host, { datasetIds: ['joined'], transforms: [], visualizations: [v.id] }, {
      [`visualizations/${v.id}.json`]: { ...settings, kind: 'vector', style: { ...settings.style, pattern: { kind: 'constant', pattern: 'zigzag' }, opacity: { kind: 'constant', value: 2 }, glow: true } },
    })
    expect(bad.isError).toBe(true)
    for (const bit of ['kind: "price" draws as colors ("scalar")']) expect(bad.content).toContain(bit)
    const bad2 = await writeAndApply(host, { datasetIds: ['joined'], transforms: [], visualizations: [v.id] }, { [`visualizations/${v.id}.json`]: { ...settings, style: { ...settings.style, glow: true } } })
    expect(bad2.content).toContain('unknown field "glow"')
    const bad3 = await writeAndApply(host, { datasetIds: ['joined'], transforms: [], visualizations: [v.id] }, { [`visualizations/${v.id}.json`]: { ...settings, style: { ...settings.style, pattern: { kind: 'constant', pattern: 'zigzag' } } } })
    expect(bad3.content).toContain('pattern.pattern must be one of hatch')
  })

  it('renames and describes datasets in /datasets.json (store, rows, origin read-only), linked ones too, as local changes', async () => {
    const { host, calls } = fakeHost({ ...emptyWorkspace('Test'), datasetIds: ['prices', 'shared'] })
    await runTool(host, 'get_workspace', {})
    const files = JSON.parse((await edit(host, { command: 'view', path: '/datasets.json' })).content.replace(/^\s*\d+\t/gm, ''))
    // The document's facts for each dataset: the origin structured, as in a downloaded zip.
    expect(files.prices).toEqual({ name: 'PRICES', description: '', metadata: {}, notes: '', store: 'local', rows: 10, origin: { kind: 'upload', source: 'Device · test.csv' } })
    expect(files.shared.store).toBe('remote')
    const write = (o: object) => edit(host, { command: 'create', path: '/datasets.json', file_text: JSON.stringify(o) })
    await write({ ...files, prices: { ...files.prices, rows: 11 } })
    expect((await runTool(host, 'apply_workspace', {})).content).toMatch(/"rows" is read-only/)
    await write({ ...files, prices: { ...files.prices, name: 'Home prices', description: 'Zillow ZHVI by county' } })
    const r = await runTool(host, 'apply_workspace', {})
    expect(r.summary).toBe('renamed dataset “PRICES” → “Home prices” (and its description)')
    expect(calls).toEqual(['update prices {"name":"Home prices","description":"Zillow ZHVI by county"}'])
  })

  it('edits a dataset\'s metadata and notes in /datasets.json, checking the metadata\'s fields', async () => {
    const { host, calls } = fakeHost({ ...emptyWorkspace('Test'), datasetIds: ['prices'] })
    await runTool(host, 'get_workspace', {})
    const files = JSON.parse((await edit(host, { command: 'view', path: '/datasets.json' })).content.replace(/^\s*\d+\t/gm, ''))
    const write = (o: object) => edit(host, { command: 'create', path: '/datasets.json', file_text: JSON.stringify(o) })
    await write({ ...files, prices: { ...files.prices, metadata: { row: 'one county', source: { publisher: 'Zillow', site: 'x' } } } })
    expect((await runTool(host, 'apply_workspace', {})).content).toContain('metadata.source: unknown field "site"')
    const metadata = { row: 'one per US county', key: 'fips (5-digit text)', columns: [{ name: 'zhvi', meaning: 'typical home value', unit: '$' }], source: { publisher: 'Zillow', publisherAbout: 'a real-estate marketplace', period: 'Sept 2026', method: 'a model over sales' }, caveats: ['Rural counties are thin'] }
    await write({ ...files, prices: { ...files.prices, metadata, notes: 'Smoothed, seasonally adjusted.' } })
    const r = await runTool(host, 'apply_workspace', {})
    expect(r.summary).toBe('updated dataset “PRICES”: metadata, notes')
    expect(JSON.parse(calls[0].replace(/^update prices /, ''))).toEqual({ metadata, notes: 'Smoothed, seasonally adjusted.' })
  })

  it('keeps a transform\'s description in its file', async () => {
    const { host, state } = fakeHost({ ...emptyWorkspace('Test'), datasetIds: ['prices'] })
    const r = await writeAndApply(
      host,
      { datasetIds: ['prices'], transforms: ['clean'], visualizations: [] },
      { 'transforms/clean.json': { name: '1 Clean', description: 'Keeps one row per county and names the columns plainly.', inputs: [{ datasetId: 'prices', alias: 'p' }], outputs: [{ key: 'main', name: 'Clean prices' }] }, 'transforms/clean.main.sql': 'SELECT * FROM p' },
    )
    expect(r.isError, r.content).toBe(false)
    expect(state.doc.transforms[0].description).toBe('Keeps one row per county and names the columns plainly.')
  })

  it('keeps the workspace\'s About note in /about.md: written, applied into the draft, cleared', async () => {
    const { host, state } = fakeHost({ ...emptyWorkspace('Test'), datasetIds: ['prices'] })
    await runTool(host, 'get_workspace', {})
    expect((await edit(host, { command: 'view', path: '/about.md' })).isError).toBe(false)
    await edit(host, { command: 'create', path: '/about.md', file_text: '## Question\nWhere are homes affordable?\n' })
    const r = await runTool(host, 'apply_workspace', {})
    expect(r.summary).toBe('updated About (/about.md)')
    expect(state.doc.about).toBe('## Question\nWhere are homes affordable?')
    await runTool(host, 'get_workspace', {})
    expect((await edit(host, { command: 'view', path: '/about.md' })).content).toContain('Where are homes affordable?')
    await edit(host, { command: 'create', path: '/about.md', file_text: '' })
    expect((await runTool(host, 'apply_workspace', {})).summary).toBe('cleared About (/about.md)')
    expect(state.doc.about).toBeUndefined()
  })

  it('asks a plain yes / no (no questions) and hands the answer and its comments back', async () => {
    const { host, calls } = fakeHost()
    const out = await runTool(host, 'ask_user', { title: 'Join prices onto counties?', context: 'Both are by county FIPS.', questions: [] })
    expect(json(out.content)).toEqual({ button: 'No', comments: 'Use 2024 only', note: USER_NOTES })
    expect(out.summary).toBe('No · comments')
    expect(calls).toEqual(['ask Join prices onto counties? | Both are by county FIPS.'])
    expect(await runTool(host, 'ask_user', {})).toMatchObject({ isError: true })
    expect(await runTool(host, 'ask_user', { title: 'Q', questions: [{ kind: 'answer', question: 'Explain', text: '' }] })).toMatchObject({ isError: true, content: expect.stringContaining('considered response') })
  })

  it('asks up to three related questions on one card, answered together', async () => {
    const { host } = fakeHost()
    let shown: Card | undefined
    host.ask = async (card) => {
      shown = card
      return answering((_c, s) => {
        s.q2.choices = ['2023', '2024']
        s.q2.comments = 'and 2019 if it exists'
      })(card)
    }
    const out = await runTool(host, 'ask_user', {
      title: 'Settle the years and the name',
      questions: [
        { kind: 'answer', question: 'The dataset name', why: 'Shown in the lists', text: 'Home prices', options: [], recommended: '', neither: false, selected: [], required: true },
        { kind: 'several', question: 'Which years?', why: '', text: '', options: ['2022', '2023', '2024'], recommended: '', neither: false, selected: ['2024'], required: false },
      ],
      buttons: ['Use these', 'Skip'],
    })
    expect(shown?.buttons).toEqual(['Use these', 'Skip'])
    expect(shown?.revise).toBeUndefined() // Revise belongs to exchanges, not one-off questions
    expect(json(out.content)).toMatchObject({
      button: 'Use these',
      answers: [
        { question: 'The dataset name', edited: false },
        { question: 'Which years?', choices: ['2023', '2024'], comments: 'and 2019 if it exists' },
      ],
    })
    expect(out.summary).toBe('Use these · The dataset name as proposed · Which years? 2023, 2024 (+ comments)')
  })

  it('Plan: proposes, comes back approved as is, edited, or to revise (twice at most)', async () => {
    const { host } = fakeHost()
    let shown: Card | undefined
    host.ask = async (card) => ((shown = card), answering(() => {})(card))
    expect(json((await runTool(host, 'propose_plan', { plan: 'Clean, join, map.' })).content)).toEqual({ decision: 'approved', edited: false, next: 'Go ahead.' })
    expect(shown).toMatchObject({ title: 'Approve the plan?', buttons: ['Approve', 'Reject'], revise: true })
    host.ask = answering((_c, s) => void (s.plan.text = 'Clean, join, then map by state.'))
    expect(json((await runTool(host, 'propose_plan', { plan: 'Clean, join, map.' })).content)).toMatchObject({ decision: 'approved', edited: true, plan: 'Clean, join, then map by state.' })
    host.ask = async (card) => ((shown = card), answering(() => 'Revise with my notes', 'by state')(card))
    expect(json((await runTool(host, 'propose_plan', { plan: 'v1' })).content)).toMatchObject({ decision: 'revise', comments: ['by state'] })
    expect(json((await runTool(host, 'propose_plan', { plan: 'v2' })).content).next).toMatch(/last revision round/)
    await runTool(host, 'propose_plan', { plan: 'v3' })
    expect(shown?.revise).toBeUndefined()
  })

  it('Source pick: the user keeps one or several sources, with the combination as edited', async () => {
    const { host } = fakeHost()
    const sources = [
      { name: 'Census ACS', detail: 'every county, 2023' },
      { name: 'HUD FMR', detail: 'every county, 2024' },
    ]
    host.ask = answering(() => {})
    expect(json((await runTool(host, 'pick_source', { need: 'county rents', sources, recommended: ['HUD FMR'], combination: '' })).content)).toMatchObject({ decision: 'approved', sources: ['HUD FMR'] })
    const both = json((await runTool(host, 'pick_source', { need: 'county rents', sources, recommended: ['HUD FMR', 'Census ACS'], combination: 'HUD anchors; ACS fills in.' })).content)
    expect(both).toMatchObject({ sources: ['Census ACS', 'HUD FMR'], combination: 'HUD anchors; ACS fills in.', combinationEdited: false })
    expect(await runTool(host, 'pick_source', { need: 'x', sources: [], recommended: [], combination: '' })).toMatchObject({ isError: true })
  })

  it('Frame: approved, it is written into About as the Study frame (the rest of About kept)', async () => {
    const { host, state } = fakeHost()
    state.doc = { ...state.doc, about: '## Notes\nMine.' }
    host.ask = answering(() => {})
    const out = json(
      (
        await runTool(host, 'propose_frame', {
          framing: 'Where a typical worker earns the most in a year, in buying power.',
          why: '',
          components: [
            { name: 'Average wage', posture: 'anchor + proxy', note: 'OECD + ILOSTAT', key: true },
            { name: 'Taxes', posture: 'fermi', note: '', key: false },
          ],
          decision: { question: '', why: '', options: [], recommended: '' },
        })
      ).content,
    )
    expect(out).toMatchObject({ decision: 'approved', edited: false, kept: ['Average wage (anchor + proxy)'], leftOut: ['Taxes'], savedTo: expect.stringContaining('Study frame') })
    expect(state.doc.about).toMatch(/^## Study frame\n\nWhere a typical worker/)
    expect(state.doc.about).toContain('## Notes\nMine.')
    // Rejected: About stays as it is.
    host.ask = answering(() => 'Reject')
    const before = state.doc.about
    await runTool(host, 'propose_frame', { framing: 'Other', why: '', components: [{ name: 'X', posture: 'exact', note: '', key: true }], decision: { question: '', why: '', options: [], recommended: '' } })
    expect(state.doc.about).toBe(before)
  })

  it('Run: sends the scout after the user approves the brief, and returns its report', async () => {
    const { host } = fakeHost()
    const sent: string[] = []
    host.ask = answering((_c, s) => {
      s.brief.text = 'Find county rents, 2024'
      s.cap.choice = '$0.50'
    })
    host.web = async (role, brief, cap) => (sent.push(`${role} ${cap} ${brief}`), { sessionId: 's1', report: 'Census ACS B25064 has it', files: [], cost: 0.03, elapsedSeconds: 40, stop: 'end_turn' })
    const out = await runTool(host, 'send_scout', { brief: 'Find county rents', cap_dollars: 0.7 })
    expect(sent).toEqual(['scout 0.5 Find county rents, 2024'])
    expect(json(out.content)).toMatchObject({ report: 'Census ACS B25064 has it', cost: 0.03, briefEditedByUser: 'Find county rents, 2024' })
    expect(out.summary).toBe('finished · 40 s · $0.03')
  })

  it('Run: offers the recommended cap first, the usual ones after it, and the user\'s own amount (Neither + comments)', async () => {
    const { host } = fakeHost()
    let shown: Card | undefined
    const caps: number[] = []
    host.web = async (_r, _b, cap) => (caps.push(cap), { sessionId: 's1', report: 'ok', files: [], elapsedSeconds: 1, stop: 'end_turn' })
    host.ask = async (card) => ((shown = card), answering(() => {})(card))
    await runTool(host, 'send_scout', { brief: 'b', cap_dollars: 1.4, cap_reason: '2 sources ×2' })
    expect(shown!.questions[1]).toMatchObject({ kind: 'one', question: 'The spending cap', options: ['Recommended: $1.40', '$0.50', '$1', '$2', '$5'], recommended: 'Recommended: $1.40', neither: true })
    expect(shown!.questions[1].why).toContain('2 sources ×2')
    const own = (text: string) => answering((_c, s) => {
      s.cap.choice = NEITHER
      s.cap.comments = text
    })
    host.ask = own('$3')
    await runTool(host, 'send_scout', { brief: 'b', cap_dollars: 1 })
    host.ask = own('2.5 dollars')
    await runTool(host, 'send_scout', { brief: 'b' })
    host.ask = own('$900')
    await runTool(host, 'send_scout', { brief: 'b' })
    expect(caps).toEqual([1.4, 3, 2.5, 25])
  })

  it('lists recent runs, and collects a run by its id (its CSVs as datasets, the scout\'s report as is)', async () => {
    const { host } = fakeHost()
    expect(await runTool(host, 'list_runs', {})).toMatchObject({ isError: false, summary: 'no runs on this device' })
    host.runs = () => [{ sessionId: 'sesn_1', role: 'scraper', brief: 'Fetch rents', startedAt: Date.UTC(2026, 9, 31), state: 'failed', error: 'Failed while following the run: …' }]
    expect(json((await runTool(host, 'list_runs', {})).content).runs[0]).toMatchObject({ runId: 'sesn_1', state: 'failed', error: 'Failed while following the run: …' })
    expect(await runTool(host, 'fetch_run', { runId: 'sesn_1' })).toMatchObject({ isError: true, content: "Fetching a run isn't available here." })
    host.fetchRun = async (id) => ({ sessionId: id, role: 'scraper', brief: 'Fetch rents', report: 'Two files', files: [{ id: 'f1', name: 'rents.csv', bytes: 10 }, { id: 'f2', name: 'script.py', bytes: 5 }], cost: 0.06, elapsedSeconds: 360, stop: 'end_turn' })
    const imports: string[] = []
    host.importWebFile = async (id, name, description) => (imports.push(`${id} ${name} ${description.includes('scraper run sesn_1') && description.includes('Fetch rents')}`), { ok: true, id: `ds-${id}` })
    const out = await runTool(host, 'fetch_run', { runId: 'sesn_1' })
    expect(out).toMatchObject({ isError: false, summary: 'finished · $0.06 · 1 dataset' })
    expect(json(out.content).files).toEqual([{ name: 'rents.csv', datasetId: 'ds-f1' }, { name: 'script.py', bytes: 5 }])
    expect(imports).toEqual(['f1 rents.csv true'])
    host.fetchRun = async () => 'That run is being followed right now; its results arrive with it.'
    expect(await runTool(host, 'fetch_run', { runId: 'sesn_1' })).toMatchObject({ isError: true, summary: 'not fetched' })
    // read_run: looks inside a run, changing nothing.
    expect(await runTool(host, 'read_run', { runId: 'sesn_1' })).toMatchObject({ isError: true, content: "Reading a run isn't available here." })
    host.readRun = async (id) => (id === 'sesn_1' ? { text: 'run sesn_1: status idle, stopped: end_turn\n[tool] web_fetch https://x.gov', status: 'idle', files: ['a.csv'] } : 'No such run')
    expect(await runTool(host, 'read_run', { runId: ' sesn_1 ' })).toMatchObject({ isError: false, summary: 'idle · 1 file', content: expect.stringContaining('web_fetch https://x.gov') })
    expect(await runTool(host, 'read_run', { runId: 'sesn_9' })).toMatchObject({ isError: true, summary: 'not read', content: 'No such run' })
  })

  it('asks for a diagnosis through the page, and hands its report back', async () => {
    const { host } = fakeHost()
    expect(await runTool(host, 'diagnose', { what_happened: 'x' })).toMatchObject({ isError: true })
    host.diagnose = async (what) => ({ report: `## Summary\n${what}`, model: 'claude-opus-5-5' })
    const out = await runTool(host, 'diagnose', { what_happened: 'The scraper finished but its results never arrived.' })
    expect(out).toMatchObject({ isError: false, summary: 'report written · claude-opus-5-5' })
    expect(json(out.content).report).toContain('never arrived')
    host.diagnose = async () => "The user didn't want a diagnosis now (Not now)."
    expect(await runTool(host, 'diagnose', { what_happened: 'x' })).toMatchObject({ isError: true, summary: 'no diagnosis' })
  })

  it("doesn't send when the user declines, and imports the scraper's CSVs when it runs", async () => {
    const { host } = fakeHost()
    host.web = async () => ({ sessionId: 's2', report: 'Two files', files: [{ id: 'f1', name: 'rents.csv', bytes: 10 }, { id: 'f2', name: 'script.py', bytes: 5 }, { id: 'f3', name: 'bad.csv', bytes: 1 }], elapsedSeconds: 90, stop: 'end_turn' })
    host.ask = answering((_c, s) => {
      s.brief.comments = 'Try the Census first'
      return 'Not now'
    })
    expect(json((await runTool(host, 'send_scraper', { brief: 'Fetch rents' })).content)).toMatchObject({ sent: false, decision: 'declined', comments: ['Try the Census first'] })
    host.ask = answering((_c, s) => void (s.cap.choice = '$2'))
    const imports: string[] = []
    host.importWebFile = async (id, name, description) => (imports.push(`${id} ${name} ${description.slice(0, 14)}`), id === 'f3' ? { ok: false, message: 'empty file' } : { ok: true, id: `ds-${id}` })
    const out = await runTool(host, 'send_scraper', { brief: 'Fetch rents' })
    expect(imports).toEqual(['f1 rents.csv From the web, ', 'f3 bad.csv From the web, '])
    expect(json(out.content).files).toEqual([{ name: 'rents.csv', datasetId: 'ds-f1' }, { name: 'script.py', bytes: 5 }, { name: 'bad.csv', importError: 'empty file' }])
    expect(out.summary).toBe('finished · 90 s · 1 dataset added')
    host.web = async () => 'Sign in to send the scout or the scraper.'
    expect(await runTool(host, 'send_scraper', { brief: 'Fetch rents' })).toMatchObject({ isError: true, content: 'Sign in to send the scout or the scraper.' })
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
        'visualizations/price.json': { name: 'Price', datasetId: 'joined', binding: { kind: 'geometry', column: 'geometry', label: 'name' }, column: 'price', style: { color: { kind: 'colormap', colormap: 'magma' } } },
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
        'visualizations/a.json': { name: 'A', datasetId: 'prices', binding: { kind: 'geometry', column: 'fips' }, column: 'price' },
        'visualizations/b.json': { name: 'B', datasetId: 'counties', binding: { kind: 'geometry', column: 'geometry' }, column: 'nope' },
        'visualizations/c.json': { name: 'C', datasetId: 'counties', binding: { kind: 'geometry', column: 'geometry' }, column: 'name', aggregation: 'sum' },
        'visualizations/d.json': { name: 'D', datasetId: 'counties', binding: { kind: 'geometry', column: 'geometry' }, column: 'name', style: { color: { kind: 'colormap', colormap: 'rainbow' } } },
      },
    )
    expect(out.isError).toBe(true)
    for (const bit of ['no dataset "ghost"', 'not a geometry column', '"nope" isn\'t a value column', "sum doesn't apply", 'colormap must be one of']) expect(out.content).toContain(bit)
    expect(state.doc).toBe(before)

    // File-level problems: SQL inside JSON, a missing SQL file, broken JSON, an unknown field.
    const files = await writeAndApply(
      host,
      { datasetIds: ['prices'], transforms: ['t'], visualizations: ['v', 'w'] },
      {
        'transforms/t.json': { name: 'T', inputs: [{ datasetId: 'prices', alias: 'p' }], outputs: [{ key: 'o1', name: 'Out', sql: 'SELECT 1' }] },
        'visualizations/v.json': '{ "name": "V", }',
        'visualizations/w.json': { name: 'W', datasetId: 'prices', binding: { kind: 'geometry', column: 'g' }, column: 'price', colour: 'red' },
      },
    )
    for (const bit of ["SQL doesn't go in the JSON", 'its SQL file /transforms/t.o1.sql is missing', "/visualizations/v.json isn't valid JSON", 'unknown field "colour"']) expect(files.content).toContain(bit)
    expect(state.doc).toBe(before)
  })

  it('reports files nothing uses, and keeps items whose files were not touched exactly', async () => {
    const { host, state } = fakeHost()
    await writeAndApply(host, { datasetIds: ['joined'], transforms: [], visualizations: ['price'] }, { 'visualizations/price.json': { name: 'Price', datasetId: 'joined', binding: { kind: 'geometry', column: 'geometry' }, column: 'price' } })
    const before = state.doc
    await runTool(host, 'get_workspace', {})
    await edit(host, { command: 'create', path: '/transforms/spare.o1.sql', file_text: 'SELECT 1' })
    await edit(host, { command: 'str_replace', path: '/workspace.json', old_str: '"name": "Test"', new_str: '"name": "Renamed"' })
    const out = json((await runTool(host, 'apply_workspace', {})).content)
    expect(out).toMatchObject({ changed: ['name → "Renamed"'], unusedFiles: expect.stringContaining('/transforms/spare.o1.sql') })
    expect(state.doc.visualizations).toEqual(before.visualizations)
  })

  it('runs transforms and deletes datasets (this device\'s copies, linked ones too)', async () => {
    const doc: WorkspaceDoc = {
      ...emptyWorkspace('Test'),
      datasetIds: ['prices', 'shared', 'joined'],
      transforms: [
        { id: 't1', name: 'Local', inputs: [{ datasetId: 'shared', alias: 's' }], outputs: [{ key: 'o', name: 'Out', sql: 'SELECT 1', outputId: 'joined' }] },
        { id: 't2', name: 'Remote out', inputs: [{ datasetId: 'prices', alias: 'p' }], outputs: [{ key: 'o', name: 'Out', sql: 'SELECT 1', outputId: 'shared' }] },
      ],
    }
    const { host, calls } = fakeHost(doc)
    const run = await runTool(host, 'run_transform', { id: 't1' })
    expect(run.summary).toBe('10 rows → JOINED')
    // Each output comes with its check: rows against the inputs', columns (lib/agent/checks.ts).
    expect(json(run.content).outputs[0].check).toMatchObject({ inputs: [{ alias: 's' }], columns: [{ name: 'name' }, { name: 'price' }, { name: 'geometry' }] })
    // A linked (cloud) output is this device's copy too: the run changes it here (it turns ↑ until the user syncs).
    expect((await runTool(host, 'run_transform', { id: 't2' })).isError).toBe(false)
    expect(await runTool(host, 'delete_dataset', { id: 'prices' })).toMatchObject({ isError: true, summary: 'refused: still used' })
    // Not made in this chat: only when the user asked for it by name.
    expect(await runTool(host, 'delete_dataset', { id: 'joined' })).toMatchObject({ isError: true, summary: 'refused: not yours' })
    expect((await runTool(host, 'delete_dataset', { id: 'joined', userAsked: true })).isError).toBe(false)
    expect(calls).toEqual(['run t1', 'run t2', 'delete joined'])
    expect(await runTool(host, 'drop_everything', {})).toMatchObject({ isError: true })
  })

  it('lists the stories and their visualizations in the overview, so a rewrite keeps the same maps', async () => {
    const viz = { kind: 'scalar', id: 'v1', name: 'Price', datasetId: 'joined', binding: { kind: 'geometry', column: 'geometry' }, column: 'price', aggregation: 'mean', visible: true, style: { color: { kind: 'constant', color: '#fff' }, opacity: { kind: 'constant', value: 1 }, pattern: { kind: 'none' } } }
    const story = { id: 's1', name: 'How prices are mapped', visualizationIds: ['v1', 'gone'], writtenAt: '2026-11-01T00:00:00Z', scenes: [{ id: 'a', title: 'T', narrative: 'N', figures: [] }] }
    const { host } = fakeHost({ ...emptyWorkspace('Test'), datasetIds: ['joined'], visualizations: [viz as never], stories: [story as never] })
    const w = (await runTool(host, 'get_workspace', {})).content
    expect(w).toContain('## Stories (1;')
    expect(w).toContain('- s1  "How prices are mapped"  1 scenes · written 2026-11-01')
    expect(w).toContain('visualizations: v1 (Price), gone (no longer in the workspace)')
  })

  it('hands stories to the storyteller (tell_story), for visualizations of the workspace', async () => {
    const doc: WorkspaceDoc = { ...emptyWorkspace('Test'), datasetIds: ['joined'], visualizations: [{ kind: 'scalar', id: 'v1', name: 'Price', datasetId: 'joined', binding: { kind: 'geometry', column: 'geometry' }, column: 'price', aggregation: 'mean', visible: true, style: { color: { kind: 'constant', color: '#fff' }, opacity: { kind: 'constant', value: 1 }, pattern: { kind: 'none' } } } as never] }
    const { host } = fakeHost(doc)
    expect(await runTool(host, 'tell_story', { visualizationIds: ['v1'], wishes: '', storyId: '' })).toMatchObject({ isError: true, content: "The storyteller isn't available here" })
    const asked: object[] = []
    host.tellStory = async (req) => (asked.push(req), { storyId: 's1', name: 'How prices are mapped', scenes: ['Prices', 'The map'] })
    expect(await runTool(host, 'tell_story', { visualizationIds: ['nope'], wishes: '', storyId: '' })).toMatchObject({ isError: true, content: expect.stringContaining('No visualization "nope"') })
    expect(await runTool(host, 'tell_story', { visualizationIds: ['v1'], wishes: '', storyId: 'gone' })).toMatchObject({ isError: true, content: 'No story "gone" to rewrite' })
    const out = await runTool(host, 'tell_story', { visualizationIds: ['v1'], wishes: 'for a general audience', storyId: '' })
    expect(out).toMatchObject({ isError: false, summary: '“How prices are mapped” · 2 scenes' })
    expect(asked).toEqual([{ visualizationIds: ['v1'], wishes: 'for a general audience' }])
    host.tellStory = async () => 'The storyteller stopped (truncated) without writing the story.'
    expect(await runTool(host, 'tell_story', { visualizationIds: ['v1'], wishes: '', storyId: '' })).toMatchObject({ isError: true, summary: 'not written' })
  })

  it('asks for a description of every dataset it made, until there is one', async () => {
    const doc: WorkspaceDoc = {
      ...emptyWorkspace('Test'),
      datasetIds: ['prices', 'joined'],
      transforms: [{ id: 't1', name: 'Join', inputs: [{ datasetId: 'prices', alias: 'p' }], outputs: [{ key: 'o', name: 'Out', sql: 'SELECT 1', outputId: 'joined' }] }],
    }
    const { host } = fakeHost(doc)
    host.runTransform = async () => ({ ok: true, outputs: [{ datasetId: 'joined', name: 'JOINED', rowCount: 10, created: true }] })
    expect(json((await runTool(host, 'run_transform', { id: 't1' })).content).describe).toMatch(/^"JOINED" \(joined\) — datasets you made that still need a description/)
    // The import note a scraped file starts with isn't a description yet.
    host.record('joined')!.description = webFileDescription('2026-10-31', 's1', 'Fetch rents per county, '.repeat(10))
    expect(json((await runTool(host, 'run_transform', { id: 't1' })).content).describe).toMatch(/only the import note/)
    host.record('joined')!.description = 'Row: one county, key fips.\nMade by: Join, from prices; adds the county names so the map can label them.'
    expect(json((await runTool(host, 'run_transform', { id: 't1' })).content).describe).toBeUndefined()
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

  it("removes only what it made in this chat, unless the user asked", async () => {
    const { host } = fakeHost({ ...emptyWorkspace('Test'), datasetIds: ['joined', 'counties'] })
    // The user's own visualization, then one the agent makes.
    const user = await writeAndApply(host, { datasetIds: ['joined', 'counties'], transforms: [], visualizations: ['users'] }, { 'visualizations/users.json': { name: 'Users', datasetId: 'joined', binding: { kind: 'geometry', column: 'geometry' }, column: 'price' } })
    const userId = json(user.content).added[0].id as string
    forgetChat(host) // a new chat: that visualization is now the user's
    const mine = await writeAndApply(host, { datasetIds: ['joined', 'counties'], transforms: [], visualizations: [userId, 'mine'] }, { 'visualizations/mine.json': { name: 'Mine', datasetId: 'joined', binding: { kind: 'geometry', column: 'geometry' }, column: 'price' } })
    const mineId = json(mine.content).added[0].id as string
    // Dropping the user's visualization: refused, nothing changes.
    const refused = await writeAndApply(host, { datasetIds: ['joined', 'counties'], transforms: [], visualizations: [mineId] }, {})
    expect(refused.summary).toBe('refused: 1 problem')
    expect(refused.content).toContain(`visualization "Users" (${userId}), which you didn't make in this chat`)
    expect(host.doc().visualizations.map((v) => v.name)).toEqual(['Users', 'Mine'])
    // Its own: fine. The user's, when they asked for it by name: fine.
    expect((await writeAndApply(host, { datasetIds: ['joined', 'counties'], transforms: [], visualizations: [userId] }, {})).isError).toBe(false)
    await runTool(host, 'get_workspace', {})
    await edit(host, { command: 'create', path: '/workspace.json', file_text: JSON.stringify({ name: 'Test', datasetIds: ['joined', 'counties'], transforms: [], visualizations: [] }) })
    expect((await runTool(host, 'apply_workspace', { userAsked: [userId] })).isError).toBe(false)
    expect(host.doc().visualizations).toEqual([])
  })

  it('lists the built-in tables and adds one without the web', async () => {
    const { host } = fakeHost()
    host.builtins = () => [{ table: 'us_states', label: 'US states', description: 'State boundaries' }]
    host.addBuiltin = async (table) => ({ ok: true, id: `ds-${table}` })
    const listed = json((await runTool(host, 'list_datasets', {})).content)
    expect(listed.builtins).toEqual([{ table: 'us_states', name: 'US states', description: 'State boundaries' }])
    expect(listed.datasets).toHaveLength(4)
    expect(json((await runTool(host, 'add_builtin', { table: 'us_states' })).content)).toEqual({ datasetId: 'ds-us_states', name: 'US states' })
    expect(await runTool(host, 'add_builtin', { table: 'mars' })).toMatchObject({ isError: true, content: expect.stringContaining('us_states') })
    // Made in this chat: it may delete it again.
    expect((await runTool(host, 'delete_dataset', { id: 'ds-us_states' })).summary).not.toBe('refused: not yours')
  })

  it('keeps strict tools few: every strict schema is compiled into one grammar, and too large a one is refused', () => {
    // 19 strict tools gave "The compiled grammar is too large" (2026-11-05). Strict only where the input is nested
    // and a malformed one really hurts; the rest validate their own input. Adding one here is a deliberate choice.
    expect(TOOLS.filter((t) => t.strict).map((t) => t.name).sort()).toEqual(['apply_workspace', 'ask_user', 'pick_source', 'propose_frame', 'query_sql'])
  })

  it('the scout: the brief carries its needs; the sources it found come back structured', async () => {
    const { host } = fakeHost()
    let shown: Card | undefined
    host.ask = async (card) => ((shown = card), answering(() => {})(card))
    host.web = async () => ({
      sessionId: 'sesn_7',
      report: 'One good source.\nSOURCES: {"needs":[{"need":"average annual wage per country","sources":[{"name":"OECD","url":"https://oecd.org/w","measures":"USD PPP","coverage":"38 countries"}]}]}',
      files: [],
      cost: 0.12,
      elapsedSeconds: 50,
      stop: 'end_turn',
    })
    const out = await runTool(host, 'send_scout', { brief: 'Best paid countries.', needs: [{ need: 'average annual wage per country', measure: 'annual, USD PPP', where: 'every country, latest year', posture: 'anchor + proxy' }] })
    expect((shown!.questions[0] as { text: string }).text).toBe('Best paid countries.\n\nNeeds:\n- average annual wage per country — annual, USD PPP; every country, latest year (anchor + proxy)')
    expect(json(out.content)).toMatchObject({ report: 'One good source.', sources: [{ need: 'average annual wage per country', sources: [{ name: 'OECD' }] }] })
    expect(out.summary).toBe('finished · 50 s · $0.12 · 1 source')
  })

  it('a brief without needs is sent as written', () => {
    expect(briefWithNeeds('  Find rents. ', undefined)).toBe('Find rents.')
    expect(briefWithNeeds('Find rents.', [{ need: '' }, 3])).toBe('Find rents.')
  })

  it('list_datasets gives each dataset\'s source, period, coverage and caveats, to judge a match before scouting', async () => {
    const { host } = fakeHost()
    const all = await host.listDatasets()
    host.listDatasets = async () => [
      {
        ...all[0],
        metadata: { row: 'one per country and year', source: { publisher: 'OECD', title: 'Average annual wages', period: '2000-2024', coverage: '38 OECD countries' }, caveats: ['USD PPP, constant prices'] },
      },
    ]
    const out = json((await runTool(host, 'list_datasets', {})).content)
    const first = (Array.isArray(out) ? out : out.datasets)[0]
    expect(first).toMatchObject({ row: 'one per country and year', source: 'OECD: Average annual wages', period: '2000-2024', coverage: '38 OECD countries', caveats: ['USD PPP, constant prices'] })
  })

  it('data from the web is described by the assistant before the workspace changes: description and source both', () => {
    const scraped = { id: 'web', name: 'rents', description: webFileDescription('2026-11-05', 'sesn_1', 'Fetch rents'), metadata: undefined } as unknown as DatasetRecord
    const host = { record: (id: string) => (id === 'web' ? scraped : undefined) }
    expect(notDescribed(host, ['web'], {})[0]).toMatch(/"rents" \(web\) came from the web and isn't described yet: give it a description .* and its metadata with the source/)
    // A description alone isn't enough; with the source too, it goes through. Taken out of the workspace, nothing is asked.
    expect(notDescribed(host, ['web'], { web: { description: 'Median rent per county, from the Census Bureau.' } })[0]).not.toContain('a description')
    expect(notDescribed(host, ['web'], { web: { description: 'Median rent per county, from the Census Bureau.', metadata: { source: { publisher: 'US Census Bureau' } } } })).toEqual([])
    expect(notDescribed(host, [], {})).toEqual([])
  })

  it('recipe: a piece\'s SQL, with the metadata an estimate carries; correlate is a query to compare sides; plain names only', async () => {
    const { host } = fakeHost()
    const r = await runTool(host, 'recipe', { kind: 'fill', table: 'tv', unit: 'state', x: 'savvy_population', y: 'tv_revenue' })
    expect(r.isError).toBe(false)
    const out = json(r.content)
    expect(out.sql).toContain('regr_slope')
    expect(out.metadata.estimate).toEqual({ method: 'fill', value: 'tv_revenue_filled', range: { low: 'low', likely: 'tv_revenue_filled', high: 'high' } })
    expect(out.next).toContain('fit_r2')
    const c = json((await runTool(host, 'recipe', { kind: 'correlate', table: 'tv', x: 'population', y: 'tv_revenue' })).content)
    expect(c.metadata).toBeUndefined()
    expect(c.next).toContain('query_sql')
    const bad = await runTool(host, 'recipe', { kind: 'scale', fine: 'x"; drop', unit: 'u', parent: 'p', proxy: 'w', coarse: 'c', total: 't' })
    expect(bad).toMatchObject({ isError: true, content: expect.stringContaining('must be a table or column name') })
  })
})


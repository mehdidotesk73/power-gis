import { describe, expect, it } from 'vitest'
import { lineageOf, lineageText } from './lineage'
import { chartData, chartShapes, ticks } from './chart'
import { runStoryTool, STORY_TOOLS, storyRequest, type StoryChat } from './storyTools'
import type { AgentHost } from '../agent/tools'
import { emptyWorkspace, type WorkspaceDoc } from '../workspace/workspace'
import { defaultScalarStyle, type VisualizationSpec } from '../dataset/visualization'
import type { DatasetRecord } from '../../shared/records'

const rec = (id: string, columns: DatasetRecord['columns'], description?: string): DatasetRecord => ({
  id, name: `Dataset ${id}`, table: `ds_${id}`, columns, rowCount: 3, origin: 'Device · x.csv', createdAt: '', updatedAt: '', ...(description ? { description } : {}),
})
const records = new Map<string, DatasetRecord>([
  ['raw', rec('raw', [{ name: 'fips', type: 'string' }, { name: 'income', type: 'double' }], 'Row: one county.')],
  ['shapes', rec('shapes', [{ name: 'fips', type: 'string' }, { name: 'geometry', type: 'region' }])],
  ['clean', rec('clean', [{ name: 'fips', type: 'string' }, { name: 'income', type: 'double' }])],
  ['map', rec('map', [{ name: 'name', type: 'string' }, { name: 'income', type: 'double' }, { name: 'geometry', type: 'region' }])],
  ['other', rec('other', [{ name: 'x', type: 'int' }])],
])
const viz: VisualizationSpec = {
  kind: 'scalar', id: 'v1', name: 'Income', datasetId: 'map', binding: { kind: 'geometry', column: 'geometry', label: 'name' }, column: 'income', aggregation: 'first', visible: true, style: defaultScalarStyle('double', 'region'),
}
const doc: WorkspaceDoc = {
  ...emptyWorkspace('W'),
  datasetIds: ['raw', 'shapes', 'other'],
  transforms: [
    { id: 't2', name: '2 Map', inputs: [{ datasetId: 'clean', alias: 'c' }, { datasetId: 'shapes', alias: 's' }], outputs: [{ key: 'o', name: 'Map', sql: 'SELECT * FROM c JOIN s USING (fips)', outputId: 'map' }] },
    { id: 't1', name: '1 Clean', inputs: [{ datasetId: 'raw', alias: 'r' }], outputs: [{ key: 'o', name: 'Clean', sql: 'SELECT fips, income FROM r', outputId: 'clean' }] },
  ],
  visualizations: [viz],
}

function host(rows: Record<string, unknown>[] = [{ fips: '01001', income: 5 }]) {
  const state = { doc }
  const queries: string[] = []
  const h = {
    doc: () => state.doc,
    setDoc: (d: WorkspaceDoc) => void (state.doc = d),
    record: (id: string) => records.get(id),
    dataset: async (id: string) => records.get(id),
    query: async (sql: string) => {
      queries.push(sql)
      if (/nope/.test(sql)) return { ok: false as const, error: { code: 'invalid', message: 'Binder Error: no column nope' } }
      const columns = Object.keys(rows[0] ?? {}).map((name) => ({ name, type: typeof rows[0][name] === 'number' ? 'double' : 'string' }))
      return { ok: true as const, data: { columns, rows, rowCount: rows.length } }
    },
    shape: async (id: string) => ({ columns: records.get(id)!.columns.filter((c) => c.type !== 'region'), maxRowsPerFeature: 1, geometryKind: 'region' as const, features: 3, matchedRows: 3, unmatched: 0, unmatchedSamples: [] }),
  } as unknown as AgentHost
  return { h, state, queries }
}

const blank = { caption: '', sql: '', inputs: [], chart: '', x: '', y: '', visualizationId: '', datasetId: '', geometry: '', label: '', column: '', aggregation: '', colormap: '', reverse: false, hide: [], fit: 'main' }

describe('lineage', () => {
  it('walks from the visualizations back to the starting data, each step once, inputs first', () => {
    const l = lineageOf(doc, ['v1'])
    expect(l.steps.map((s) => (s.kind === 'dataset' ? s.id : s.transform.id))).toEqual(['raw', 't1', 'clean', 'shapes', 't2', 'map'])
    const text = lineageText(l, (id) => records.get(id))
    expect(text).toContain('## Dataset "Dataset raw" (id raw)')
    expect(text).toContain('Description:\nRow: one county.')
    expect(text).toContain('SELECT fips, income FROM r')
    expect(text).toContain('- "Income" (id v1): dataset "Dataset map" (map), geometry geometry, named by name, column income (first)')
    expect(text).not.toContain('Dataset other')
    expect(storyRequest(['Income'], 'L')).toBe('Tell the story of this visualization: "Income".\n\nL')
  })
})

describe('charts', () => {
  it('shape a query into what each kind draws, and say when it does not fit', () => {
    const rows = [{ k: 'a', n: 3 }, { k: 'b', n: 1 }]
    expect(chartData('bar', 'k', 'n', ['k', 'n'], rows)).toEqual({ columns: ['k', 'n'], rows: [['a', 3], ['b', 1]] })
    expect(chartData('bar', 'k', 'z', ['k', 'n'], rows)).toMatch(/"z" isn't a column/)
    expect(chartData('pie', 'k', 'n', ['k', 'n'], [{ k: 'a', n: -1 }])).toMatch(/negative/)
    expect(chartData('bar', 'k', 'n', ['k', 'n'], Array.from({ length: 31 }, (_, i) => ({ k: i, n: i })))).toMatch(/31 rows is too many/)
    const hist = chartData('histogram', 'n', undefined, ['n'], Array.from({ length: 120 }, (_, i) => ({ n: i })))
    expect(typeof hist !== 'string' && hist.rows.reduce((s, r) => s + (r[2] as number), 0)).toBe(120)
    expect(typeof hist !== 'string' && hist.rows.length).toBe(12)
    expect(ticks(0, 95)).toEqual([0, 25, 50, 75])
  })
  it('lay out bars, slices, lines and dots inside the plot', () => {
    const bars = chartShapes('bar', { columns: ['k', 'n'], rows: [['a', 3], ['b', 1]] })
    expect(bars.bars).toHaveLength(2)
    expect(bars.bars[0].h).toBeGreaterThan(bars.bars[1].h)
    const pie = chartShapes('pie', { columns: ['k', 'n'], rows: [['a', 3], ['b', 1]] })
    expect(pie.slices.map((s) => s.share)).toEqual([0.75, 0.25])
    const line = chartShapes('line', { columns: ['x', 'y'], rows: [[2, 1], [1, 0], [3, 4]] })
    expect(line.line).toMatch(/^M [\d.]+ [\d.]+ L/)
    for (const d of line.dots) expect(d.x).toBeGreaterThanOrEqual(line.plot.x)
  })
})

describe('write_story', () => {
  const chat = (): StoryChat => ({ visualizationIds: ['v1'] })
  const scene = (figures: object[], narrative = 'Each row is a county, and incomes are in dollars.') => ({ title: 'Start', narrative, about_kind: 'dataset', about_id: 'raw', figures })

  it('is the only tool besides query_sql, and every figure property is required (strict tools)', () => {
    expect(STORY_TOOLS.map((t) => t.name)).toEqual(['query_sql', 'write_story'])
    const fig = ((STORY_TOOLS[1].inputSchema.properties as any).scenes.items.properties.figures.items) as { properties: object; required: string[] }
    expect(fig.required.sort()).toEqual(Object.keys(fig.properties).sort())
  })

  it('runs every figure, snapshots it, and saves the story into the workspace', async () => {
    const { h, state } = host()
    const c = chat()
    const out = await runStoryTool(h, c, 'write_story', {
      name: 'How income is mapped',
      scenes: [
        scene([{ ...blank, kind: 'sample', sql: 'SELECT fips, income FROM r', inputs: [{ datasetId: 'raw', alias: 'r' }], caption: 'Three counties' }]),
        scene([{ ...blank, kind: 'map', visualizationId: 'v1', hide: ['Guam'] }, { ...blank, kind: 'map', datasetId: 'clean', geometry: 'geometry', column: 'income', colormap: 'magma' }]),
      ],
    })
    expect(out).toMatchObject({ isError: false, summary: 'written · 2 scenes · 3 figures' })
    const s = state.doc.stories![0]
    expect(s).toMatchObject({ name: 'How income is mapped', visualizationIds: ['v1'], scenes: [{ about: { kind: 'dataset', id: 'raw' } }, {}] })
    expect(s.scenes[0].figures[0]).toMatchObject({ kind: 'sample', caption: 'Three counties', snapshot: { columns: ['fips', 'income'], rows: [['01001', 5]] } })
    expect(s.scenes[1].figures[0]).toMatchObject({ kind: 'map', hide: ['Guam'], viz: { datasetId: 'map', column: 'income' } })
    expect(s.scenes[1].figures[1]).toMatchObject({ kind: 'map', viz: { datasetId: 'clean', column: 'income', style: { color: { colormap: 'magma' } } } })
    // Asked again in the same chat: the same story, rewritten.
    await runStoryTool(h, c, 'write_story', { name: 'Shorter', scenes: [scene([])] })
    expect(state.doc.stories!.map((x) => [x.id, x.name])).toEqual([[s.id, 'Shorter']])
  })

  it('saves nothing until every scene and figure is right, and says what to fix', async () => {
    const { h, state } = host()
    const out = await runStoryTool(h, chat(), 'write_story', {
      name: 'X',
      scenes: [
        scene([{ ...blank, kind: 'sample', sql: 'SELECT nope FROM r', inputs: [{ datasetId: 'raw', alias: 'r' }] }], 'word '.repeat(150)),
        scene([{ ...blank, kind: 'chart', chart: 'bar', x: 'fips', y: 'missing', sql: 'SELECT * FROM r', inputs: [{ datasetId: 'raw', alias: 'r' }] }]),
        scene([{ ...blank, kind: 'sample', sql: 'SELECT 1', inputs: [{ datasetId: 'elsewhere', alias: 'e' }] }, { ...blank, kind: 'map', visualizationId: 'nope' }]),
      ],
    })
    expect(out.isError).toBe(true)
    expect(out.content).toContain('scenes[0].figures[0]: Binder Error: no column nope')
    expect(out.content).toContain(`scenes[1].figures[0]: "missing" isn't a column of the result`)
    expect(out.content).toContain(`dataset "elsewhere" isn't in the workspace`)
    expect(out.content).toContain('no visualization "nope"')
    expect(out.content).toMatch(/150 words/)
    expect(state.doc.stories).toBeUndefined()
  })
})

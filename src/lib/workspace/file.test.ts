import { describe, expect, it } from 'vitest'
import { fromWorkspaceFile, missingReport, overviewOf, parseDraft, parseWorkspaceFile, pointers, replaceDatasetIds, snapshot, toWorkspaceFile } from './file'
import type { DatasetRecord } from '../../shared/records'
import { readFileSync } from 'node:fs'
import { defaultScalarStyle, ROWS, type VisualizationSpec } from '../dataset/visualization'
import { workspaceRequires, type WorkspaceDoc } from './workspace'

const viz = (id: string, datasetId: string): VisualizationSpec => ({
  kind: 'scalar',
  id,
  name: `viz ${id}`,
  datasetId,
  binding: { kind: 'geometry', column: 'shape' },
  column: ROWS,
  aggregation: 'count',
  visible: true,
  style: defaultScalarStyle('int', 'region'),
})
const doc: WorkspaceDoc = {
  id: 'w1',
  name: 'Grid',
  datasetIds: ['a', 'b'],
  visualizations: [viz('v1', 'a'), viz('v2', 'b')],
  transforms: [
    { id: 't1', name: 'Points', inputs: [{ datasetId: 'a', alias: 'a' }], outputs: [{ key: 'o1', name: 'Points', sql: 'SELECT * FROM a', outputId: 'b' }] },
    { id: 't2', name: 'Join', inputs: [{ datasetId: 'a', alias: 'a' }, { datasetId: 'b', alias: 'b' }], outputs: [{ key: 'o1', name: 'Join', sql: 'SELECT * FROM a JOIN b USING (k)' }] },
  ],
}

const rec = (id: string, extra: Partial<DatasetRecord> = {}): DatasetRecord => ({
  id, name: `Dataset ${id}`, table: `ds_${id}`, columns: [], rowCount: 10, origin: `Device · ${id}.csv`, createdAt: '', updatedAt: '', ...extra,
})
const records: Record<string, DatasetRecord> = { a: rec('a'), b: rec('b', { origin: 'Transform · Points' }) }
const byId = (id: string) => records[id]
const empty: WorkspaceDoc = { name: '', datasetIds: [], visualizations: [], transforms: [] }

describe('workspace documents (version 2)', () => {
  it('carries the setup and the facts of every dataset it points at, never rows', () => {
    const file = toWorkspaceFile(doc, byId)
    expect(file).toMatchObject({ format: 'powergis-workspace', version: 2, workspaceId: 'w1', name: 'Grid', datasetIds: ['a', 'b'] })
    expect(file.datasets).toEqual([
      { id: 'a', name: 'Dataset a', store: 'local', rows: 10, origin: { kind: 'upload', source: 'Device · a.csv' } },
      { id: 'b', name: 'Dataset b', store: 'local', rows: 10, origin: { kind: 'output', transform: 't1', output: 'o1' } },
    ])
    expect(file.visualizations[0]).toEqual(doc.visualizations[0]) // every setting, with its id
    expect(file.transforms[0].outputs[0].sql).toBe('SELECT * FROM a')
  })

  it('round-trips through text', () => {
    const file = toWorkspaceFile(doc, byId)
    const r = parseWorkspaceFile(JSON.stringify(file))
    if (!r.ok) throw new Error(r.error)
    expect(r.file).toEqual(file)
  })

  it('names built-ins and keeps the ids a copy stands for', () => {
    const recs: Record<string, DatasetRecord> = { u: rec('u', { name: 'EIA-861 utilities', extensions: { builtin: 'utilities', version: 3 } }), c: rec('c', { extensions: { copyOf: ['orig'] } }) }
    const d: WorkspaceDoc = { ...empty, datasetIds: ['u', 'c', 'gone'] }
    expect(toWorkspaceFile(d, (id) => recs[id]).datasets).toEqual([
      { id: 'u', name: 'EIA-861 utilities', store: 'local', rows: 10, origin: { kind: 'builtin', table: 'utilities', version: 3 } },
      { id: 'c', name: 'Dataset c', store: 'local', rows: 10, origin: { kind: 'upload', source: 'Device · c.csv' }, sameAs: ['orig'] },
      { id: 'gone', name: 'Unknown dataset', store: 'local', origin: { kind: 'unknown' } },
    ])
  })

  it("carries each transform's engine extensions, and the workspace's together", () => {
    const spatial: WorkspaceDoc = { ...doc, transforms: [{ ...doc.transforms[0], requires: ['spatial'] }, doc.transforms[1]] }
    expect(workspaceRequires(spatial)).toEqual(['spatial'])
    expect(toWorkspaceFile(doc, byId)).not.toHaveProperty('requires')
    const r = parseWorkspaceFile(JSON.stringify(toWorkspaceFile(spatial, byId)))
    if (!r.ok) throw new Error(r.error)
    expect(r.file.requires).toEqual(['spatial'])
    expect(workspaceRequires(fromWorkspaceFile(r.file, empty, () => true).doc)).toEqual(['spatial'])
    const bad = { ...toWorkspaceFile(spatial, byId), transforms: [{ ...toWorkspaceFile(spatial, byId).transforms[0], requires: 'spatial' }] }
    expect(parseWorkspaceFile(JSON.stringify(bad)).ok).toBe(false)
  })

  it('rejects documents that are not workspaces, with a reason', () => {
    const file = toWorkspaceFile(doc, byId)
    expect(parseWorkspaceFile('{')).toEqual({ ok: false, error: 'This is not valid JSON.' })
    expect(parseWorkspaceFile('{"type":"FeatureCollection"}')).toMatchObject({ ok: false, error: expect.stringContaining('not a PowerGIS') })
    expect(parseWorkspaceFile(JSON.stringify({ ...file, version: 9 }))).toMatchObject({ ok: false, error: expect.stringContaining('version 9') })
    expect(parseWorkspaceFile(JSON.stringify({ ...file, visualizations: [{ id: 'x', name: 'x', datasetId: 'a', kind: 'scalar' }] }))).toMatchObject({ ok: false, error: expect.stringContaining('visualization') })
    expect(parseWorkspaceFile(JSON.stringify({ ...file, transforms: [{ id: 't', name: 'x', sql: 1, inputs: [] }] }))).toMatchObject({ ok: false, error: expect.stringContaining('transform') })
    expect(parseWorkspaceFile(JSON.stringify({ ...file, datasets: [{ id: 'a', name: 'a', store: 'local', origin: { kind: 'magic' } }] }))).toMatchObject({ ok: false, error: expect.stringContaining('dataset') })
  })

  it('loads into the current workspace, dropping datasets the database lacks and what depends on them', () => {
    const file = toWorkspaceFile(doc, byId)
    const r = fromWorkspaceFile(file, { id: 'w9', name: 'Other', datasetIds: [], visualizations: [], transforms: [] }, (id) => id === 'a')
    expect(r.missing).toEqual(['b'])
    expect(r.droppedVisualizations).toEqual(['viz v2'])
    expect(r.droppedTransforms).toEqual(['Join'])
    expect(r.doc).toMatchObject({ id: 'w9', name: 'Grid', datasetIds: ['a'] })
    expect(r.doc.visualizations).toHaveLength(1)
    expect(r.doc.visualizations[0].id).not.toBe('v1') // fresh ids: never collide with another workspace's records
    expect(r.doc.transforms).toHaveLength(1)
    expect(r.doc.transforms[0]).toMatchObject({ name: 'Points', outputs: [{ key: 'o1', outputId: undefined }] })
    const all = fromWorkspaceFile(file, doc, () => true).doc
    expect(all.transforms.map((t) => [t.name, t.outputs[0].outputId])).toEqual([['Points', 'b'], ['Join', undefined]])
  })

  it('reads version 1 documents: ids, placeholders, names and single-SQL transforms', () => {
    const v1 = {
      format: 'powergis-workspace', version: 1, exportedAt: '', name: 'Old',
      datasetIds: ['transform:0', 'builtin:utilities', 'plain-id'],
      names: { 'plain-id': 'plants' },
      visualizations: [{ name: 'V', datasetId: 'plain-id', settings: { ...viz('x', 'x'), id: undefined, name: undefined, datasetId: undefined } }],
      transforms: [{ name: 'Old', sql: 'SELECT 1', inputs: [{ datasetId: 'builtin:utilities', alias: 'u' }], outputId: 'transform:0' }],
    }
    const r = parseWorkspaceFile(JSON.stringify(v1))
    if (!r.ok) throw new Error(r.error)
    const t = r.file.transforms[0]
    expect(r.file.version).toBe(2)
    expect(t).toMatchObject({ name: 'Old', outputs: [{ key: 'o1', name: 'Old', sql: 'SELECT 1', outputId: 'transform:0' }] })
    expect(r.file.datasets).toEqual([
      { id: 'transform:0', name: 'Old', store: 'local', origin: { kind: 'output', transform: t.id, output: 'o1' } },
      { id: 'builtin:utilities', name: 'EIA-861 utilities', store: 'local', origin: { kind: 'builtin', table: 'utilities' } },
      { id: 'plain-id', name: 'plants', store: 'local', origin: { kind: 'unknown' } },
    ])
    expect(r.file.visualizations[0]).toMatchObject({ name: 'V', datasetId: 'plain-id', kind: 'scalar' })
  })

  it('swaps dataset ids everywhere they appear', () => {
    const file = replaceDatasetIds(toWorkspaceFile(doc, byId), (id) => (id === 'b' ? 'B' : undefined))
    expect(pointers(file)).toEqual(['a', 'B'])
    expect(file.datasets.map((d) => d.id)).toEqual(['a', 'B'])
  })

  it('summarizes a document for reading', () => {
    const text = overviewOf(toWorkspaceFile(doc, byId))
    expect(text).toContain('# Workspace "Grid"')
    expect(text).toContain('- Dataset b · Local · 10 rows · output of "Points"')
    expect(text).toContain('- Join: a = "Dataset a", b = "Dataset b" → "Join" (not run yet)')
  })

  it('tells drafts apart from the saved state', () => {
    expect(snapshot(doc)).toBe(snapshot({ ...doc, id: 'other' })) // the id isn't content
    expect(snapshot(doc)).not.toBe(snapshot({ ...doc, name: 'X' }))
    expect(parseDraft(JSON.stringify({ doc, saved: snapshot(doc) }))?.doc.name).toBe('Grid')
    expect(parseDraft('nope')).toBeNull()
    expect(parseDraft(null)).toBeNull()
    expect(parseDraft('{"doc":{}}')).toBeNull()
    const old = { doc: { name: 'x', datasetIds: [], visualizations: [] }, saved: '' } // a draft from before transforms
    expect(parseDraft(JSON.stringify(old))?.doc.transforms).toEqual([])
  })
})

describe('the default workspace file', () => {
  const parsed = parseWorkspaceFile(readFileSync('public/data/default.powergis.json', 'utf8'))

  it('is a version 2 document over built-ins and its transform output', () => {
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.file.version).toBe(2)
    expect(parsed.file.datasets.filter((d) => d.origin.kind === 'builtin').map((d) => (d.origin as { table: string }).table).sort()).toEqual(['us_counties', 'us_states', 'utilities', 'utility_counties'])
    expect(parsed.file.datasets.find((d) => d.origin.kind === 'output')).toMatchObject({ id: 'default-utilities-by-county', origin: { transform: 'default-t1', output: 'o1' } })
    expect(parsed.file.visualizations.every((v) => v.binding.kind === 'geometry')).toBe(true)
    expect(parsed.file.visualizations.find((v) => v.name === 'Number of utilities')).toMatchObject({ datasetId: 'default-utilities-by-county', column: 'utility_id_eia', aggregation: 'count' })
  })
})

describe('missingReport', () => {
  it('names the datasets missing here and why, the transforms that could not run, and what went with them', () => {
    const r = missingReport(
      [
        { id: 'd1', name: 'Plants 2024', rows: 412, why: 'elsewhere' },
        { id: 'd2', name: 'Prices', why: 'elsewhere' },
        { id: 'd3', name: 'Mystery', why: 'unknown' },
        { id: 'o', name: 'Joined', why: 'output' },
      ],
      [{ name: 'Join plants', reason: "an input dataset isn't on this device" }],
      ['Plants by state', 'Price map'],
      ['Join plants', 'Averages'],
    )
    expect(r.split('\n')).toEqual([
      '• 2 datasets uploaded on another device and kept only there: "Plants 2024" (412 rows), "Prices".',
      '• 1 dataset not on this device: "Mystery".',
      `• 1 transform that couldn't run: "Join plants" (an input dataset isn't on this device).`,
      '• Left out with them: 2 visualizations ("Plants by state", "Price map") and 1 transform ("Averages").',
      'Datasets uploaded on another device stay there; storing datasets in the cloud comes next.',
    ])
  })
  it('says nothing when everything is here', () => {
    expect(missingReport([], [], [], [])).toBe('')
  })
})

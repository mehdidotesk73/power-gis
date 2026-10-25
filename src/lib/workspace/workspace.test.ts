import { describe, expect, it } from 'vitest'
import {
  addDataset,
  addVisualization,
  emptyWorkspace,
  newDatasetMeta,
  parseWorkspace,
  removeDataset,
  removeVisualization,
  reorderDatasets,
  reorderVisualizations,
  serializeWorkspace,
  updateDataset,
  updateVisualization,
  type DatasetEntry,
  type OpResult,
  type WorkspaceDoc,
} from './workspace'
import { loadWorkspace, MemoryKeyValueStore, MemoryTableStore, saveWorkspace, WORKSPACE_KEY } from './storage'
import { defaultScalarStyle, ROWS, type VisualizationSpec } from '../dataset/visualization'

const entry = (id: string, name = id): DatasetEntry => ({
  id,
  name,
  binding: { kind: 'latlon', lat: 'lat', lon: 'lon' },
  origin: 'test',
  rows: { kind: 'stored' },
  meta: newDatasetMeta(),
})
const viz = (id: string, datasetId: string, column = ROWS): VisualizationSpec => ({
  kind: 'scalar',
  id,
  name: id,
  datasetId,
  column,
  aggregation: 'count',
  visible: true,
  style: defaultScalarStyle('int', 'point'),
})
const doc = (r: OpResult): WorkspaceDoc => {
  if (!r.ok) throw new Error(r.error.message)
  return r.doc
}

describe('workspace operations', () => {
  const base = doc(addDataset(doc(addDataset(emptyWorkspace(), entry('a'), [viz('a1', 'a'), viz('a2', 'a')])), entry('b'), [viz('b1', 'b')]))

  it('appends datasets and puts their visualizations on top', () => {
    expect(base.datasets.map((d) => d.id)).toEqual(['a', 'b'])
    expect(base.visualizations.map((v) => v.id)).toEqual(['b1', 'a1', 'a2'])
  })

  it('rejects duplicates, blanks and foreign visualizations with readable errors', () => {
    expect(addDataset(base, entry('a'))).toMatchObject({ ok: false, error: { code: 'duplicate' } })
    expect(addDataset(base, entry('c', ' '))).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(addDataset(base, entry('c'), [viz('x', 'a')])).toMatchObject({ ok: false, error: { code: 'invalid' } })
  })

  it('removes a dataset with its visualizations', () => {
    const d = doc(removeDataset(base, 'a'))
    expect(d.datasets.map((x) => x.id)).toEqual(['b'])
    expect(d.visualizations.map((v) => v.id)).toEqual(['b1'])
    expect(removeDataset(base, 'zz')).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('renames and describes, merging extensions', () => {
    const d1 = doc(updateDataset(base, 'a', { name: ' Plants ', description: 'EIA-860', extensions: { x: 1 } }))
    const d2 = doc(updateDataset(d1, 'a', { extensions: { y: 2 } }))
    const a = d2.datasets[0]
    expect(a.name).toBe('Plants')
    expect(a.meta.description).toBe('EIA-860')
    expect(a.meta.extensions).toEqual({ x: 1, y: 2 })
    expect(updateDataset(base, 'a', { name: '' }).ok).toBe(false)
    // The original document is untouched.
    expect(base.datasets[0].name).toBe('a')
  })

  it('reorders only with a complete permutation', () => {
    expect(doc(reorderDatasets(base, ['b', 'a'])).datasets.map((d) => d.id)).toEqual(['b', 'a'])
    expect(reorderDatasets(base, ['b']).ok).toBe(false)
    expect(reorderDatasets(base, ['a', 'a']).ok).toBe(false)
    expect(doc(reorderVisualizations(base, ['a2', 'b1', 'a1'])).visualizations.map((v) => v.id)).toEqual(['a2', 'b1', 'a1'])
    expect(reorderVisualizations(base, ['a2', 'b1', 'zz']).ok).toBe(false)
  })

  it('adds, updates and removes visualizations, validating dataset and column', () => {
    const ctx = { columns: (id: string) => (id === 'a' ? ['mw'] : []) }
    expect(doc(addVisualization(base, viz('n', 'a', 'mw'), 0, ctx)).visualizations[0].id).toBe('n')
    expect(doc(addVisualization(base, viz('n', 'a'), 99)).visualizations.at(-1)!.id).toBe('n')
    expect(addVisualization(base, viz('n', 'a', 'nope'), 0, ctx)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(addVisualization(base, viz('n', 'zz'))).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(addVisualization(base, viz('a1', 'a'))).toMatchObject({ ok: false, error: { code: 'duplicate' } })
    expect(doc(updateVisualization(base, { ...viz('a1', 'a'), visible: false })).visualizations[1].visible).toBe(false)
    expect(updateVisualization(base, viz('zz', 'a')).ok).toBe(false)
    expect(doc(removeVisualization(base, 'a1')).visualizations.map((v) => v.id)).toEqual(['b1', 'a2'])
  })
})

describe('workspace persistence', () => {
  const base = doc(addDataset(emptyWorkspace(), entry('a'), [viz('a1', 'a')]))

  it('round-trips through JSON and drops orphaned visualizations', () => {
    expect(doc(parseWorkspace(serializeWorkspace(base)))).toEqual(base)
    const orphan = { ...base, visualizations: [...base.visualizations, viz('x', 'gone')] }
    expect(doc(parseWorkspace(JSON.stringify(orphan))).visualizations.map((v) => v.id)).toEqual(['a1'])
    expect(parseWorkspace('{').ok).toBe(false)
    expect(parseWorkspace(JSON.stringify({ ...base, version: 99 })).ok).toBe(false)
  })

  it('saves and loads, and survives a store that throws', () => {
    const kv = new MemoryKeyValueStore()
    expect(loadWorkspace(kv)).toBeNull()
    expect(saveWorkspace(kv, base)).toBe(true)
    expect(loadWorkspace(kv)).toEqual(base)
    kv.set(WORKSPACE_KEY, 'garbage')
    expect(loadWorkspace(kv)).toBeNull()
    const broken = { get: () => { throw new Error('denied') }, set: () => { throw new Error('quota') }, remove() {} }
    expect(loadWorkspace(broken)).toBeNull()
    expect(saveWorkspace(broken, base)).toBe(false)
  })

  it('stores table rows as copies', async () => {
    const t = new MemoryTableStore()
    const rows = [{ v: { u: 1, v: 2 } }]
    await t.put('a', rows)
    rows[0].v.u = 9
    expect(await t.get('a')).toEqual([{ v: { u: 1, v: 2 } }])
    await t.delete('a')
    expect(await t.get('a')).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import {
  addDataset,
  addVisualization,
  emptyWorkspace,
  removeDataset,
  removeVisualization,
  renameWorkspace,
  reorderDatasets,
  reorderVisualizations,
  updateVisualization,
  addTransform,
  updateTransform,
  removeTransform,
  aliasFor,
  type OpResult,
  type WorkspaceDoc,
} from './workspace'
import { defaultScalarStyle, ROWS, type VisualizationSpec } from '../dataset/visualization'

const binding = { kind: 'geometry' as const, column: 'loc' }
const viz = (id: string, datasetId: string, column = ROWS): VisualizationSpec => ({
  kind: 'scalar',
  id,
  name: id,
  datasetId,
  binding,
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
  const base = doc(addDataset(doc(addDataset(emptyWorkspace(), 'a', [viz('a1', 'a'), viz('a2', 'a')])), 'b', [viz('b1', 'b')]))

  it('appends dataset pointers and puts their visualizations on top', () => {
    expect(base.datasetIds).toEqual(['a', 'b'])
    expect(base.visualizations.map((v) => v.id)).toEqual(['b1', 'a1', 'a2'])
  })

  it('rejects duplicates and foreign visualizations with readable errors', () => {
    expect(addDataset(base, 'a')).toMatchObject({ ok: false, error: { code: 'duplicate' } })
    expect(addDataset(base, 'c', [viz('x', 'a')])).toMatchObject({ ok: false, error: { code: 'invalid' } })
  })

  it('takes a dataset out with its visualizations, without touching the input', () => {
    const d = doc(removeDataset(base, 'a'))
    expect(d.datasetIds).toEqual(['b'])
    expect(d.visualizations.map((v) => v.id)).toEqual(['b1'])
    expect(removeDataset(base, 'zz')).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(base.datasetIds).toEqual(['a', 'b'])
  })

  it('reorders only with a complete permutation', () => {
    expect(doc(reorderDatasets(base, ['b', 'a'])).datasetIds).toEqual(['b', 'a'])
    expect(reorderDatasets(base, ['b']).ok).toBe(false)
    expect(reorderDatasets(base, ['a', 'a']).ok).toBe(false)
    expect(doc(reorderVisualizations(base, ['a2', 'b1', 'a1'])).visualizations.map((v) => v.id)).toEqual(['a2', 'b1', 'a1'])
    expect(reorderVisualizations(base, ['a2', 'b1', 'zz']).ok).toBe(false)
  })

  it('adds, updates and removes visualizations, validating dataset, column and binding columns', () => {
    const ctx = { columns: (id: string) => (id === 'a' ? ['mw', 'loc'] : []) }
    expect(doc(addVisualization(base, viz('n', 'a', 'mw'), 0, ctx)).visualizations[0].id).toBe('n')
    expect(doc(addVisualization(base, viz('n', 'a'), 99)).visualizations.at(-1)!.id).toBe('n')
    expect(addVisualization(base, viz('n', 'a', 'nope'), 0, ctx)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(addVisualization(base, { ...viz('n', 'a'), binding: { kind: 'geometry', column: 'nope' } }, 0, ctx)).toMatchObject({ ok: false })
    expect(addVisualization(base, viz('n', 'zz'))).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(addVisualization(base, viz('a1', 'a'))).toMatchObject({ ok: false, error: { code: 'duplicate' } })
    expect(doc(updateVisualization(base, { ...viz('a1', 'a'), visible: false })).visualizations[1].visible).toBe(false)
    expect(updateVisualization(base, viz('zz', 'a')).ok).toBe(false)
    expect(doc(removeVisualization(base, 'a1')).visualizations.map((v) => v.id)).toEqual(['b1', 'a2'])
  })

  it('adds, updates and removes transforms, validating inputs and table names', () => {
    const t = { id: 't1', name: 'Pts', inputs: [{ datasetId: 'a', alias: 'a' }], outputs: [{ key: 'o1', name: 'Pts', sql: 'SELECT * FROM a' }] }
    const d = doc(addTransform(base, t))
    expect(d.transforms).toEqual([t])
    expect(addTransform(d, t)).toMatchObject({ ok: false, error: { code: 'duplicate' } })
    expect(addTransform(base, { ...t, inputs: [{ datasetId: 'zz', alias: 'z' }] })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(addTransform(base, { ...t, inputs: [{ datasetId: 'a', alias: '1x' }] })).toMatchObject({ ok: false, error: { message: expect.stringContaining('table name') } })
    expect(addTransform(base, { ...t, inputs: [{ datasetId: 'a', alias: 'x' }, { datasetId: 'b', alias: 'x' }] }).ok).toBe(false)
    expect(addTransform(base, { ...t, inputs: [] }).ok).toBe(false)
    expect(doc(updateTransform(d, { ...t, outputs: [{ ...t.outputs[0], outputId: 'b' }] })).transforms[0].outputs[0].outputId).toBe('b')
    expect(addTransform(base, { ...t, outputs: [] })).toMatchObject({ ok: false, error: { message: expect.stringContaining('output') } })
    // A dataset a transform reads can't leave the workspace until the transform stops using it.
    expect(removeDataset(d, 'a')).toMatchObject({ ok: false, error: { message: expect.stringContaining('Pts') } })
    expect(doc(removeTransform(d, 't1')).transforms).toEqual([])
    expect(aliasFor('Electric utilities by county (EIA-861)')).toBe('electric_utilities_by_county_eia_861')
    expect(aliasFor('2025 plants')).toBe('t_2025_plants')
  })

  it('keeps a dataset with one writer: deleting a transform leaves its output, which a new transform can take over', () => {
    const out = (outputId?: string, key = 'o1') => ({ key, name: 'Pts', sql: 'SELECT * FROM a', ...(outputId ? { outputId } : {}) })
    const t = { id: 't1', name: 'Pts', inputs: [{ datasetId: 'a', alias: 'a' }], outputs: [out('b')] }
    const d = doc(addTransform(base, t))
    expect(addTransform(d, { ...t, id: 't2', name: 'Other' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('already written by transform "Pts"') } })
    expect(addTransform(base, { ...t, outputs: [out('a')] })).toMatchObject({ ok: false, error: { message: expect.stringContaining('its own inputs') } })
    expect(addTransform(base, { ...t, outputs: [out('b'), out('b', 'o2')] })).toMatchObject({ ok: false, error: { message: expect.stringContaining('same dataset') } })
    expect(doc(addTransform(base, { ...t, outputs: [out('b'), out(undefined, 'o2')] })).transforms[0].outputs).toHaveLength(2)
    const gone = doc(removeTransform(d, 't1'))
    expect(gone.datasetIds).toContain('b') // downstream stays
    expect(doc(addTransform(gone, { ...t, id: 't2', name: 'Relinked' })).transforms[0].outputs[0].outputId).toBe('b')
  })

  it('renames the workspace', () => {
    expect(doc(renameWorkspace(base, ' Grid ')).name).toBe('Grid')
    expect(renameWorkspace(base, '').ok).toBe(false)
  })
})

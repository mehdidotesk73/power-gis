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
  type OpResult,
  type WorkspaceDoc,
} from './workspace'
import { defaultScalarStyle, ROWS, type VisualizationSpec } from '../dataset/visualization'

const binding = { kind: 'latlon' as const, lat: 'lat', lon: 'lon' }
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
    const ctx = { columns: (id: string) => (id === 'a' ? ['mw', 'lat', 'lon'] : []) }
    expect(doc(addVisualization(base, viz('n', 'a', 'mw'), 0, ctx)).visualizations[0].id).toBe('n')
    expect(doc(addVisualization(base, viz('n', 'a'), 99)).visualizations.at(-1)!.id).toBe('n')
    expect(addVisualization(base, viz('n', 'a', 'nope'), 0, ctx)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(addVisualization(base, { ...viz('n', 'a'), binding: { kind: 'latlon', lat: 'y', lon: 'lon' } }, 0, ctx)).toMatchObject({ ok: false })
    expect(addVisualization(base, viz('n', 'zz'))).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(addVisualization(base, viz('a1', 'a'))).toMatchObject({ ok: false, error: { code: 'duplicate' } })
    expect(doc(updateVisualization(base, { ...viz('a1', 'a'), visible: false })).visualizations[1].visible).toBe(false)
    expect(updateVisualization(base, viz('zz', 'a')).ok).toBe(false)
    expect(doc(removeVisualization(base, 'a1')).visualizations.map((v) => v.id)).toEqual(['b1', 'a2'])
  })

  it('renames the workspace', () => {
    expect(doc(renameWorkspace(base, ' Grid ')).name).toBe('Grid')
    expect(renameWorkspace(base, '').ok).toBe(false)
  })
})

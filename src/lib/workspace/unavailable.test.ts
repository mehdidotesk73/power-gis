import { describe, expect, it } from 'vitest'
import { downstreamOrder, removeUnavailable, replaceDataset, unavailability } from './unavailable'
import { defaultScalarStyle, ROWS, type VisualizationSpec } from '../dataset/visualization'
import type { TransformSpec, WorkspaceDoc } from './workspace'

const viz = (id: string, datasetId: string): VisualizationSpec => ({
  kind: 'scalar', id, name: id, datasetId, binding: { kind: 'geometry', column: 'g' }, column: ROWS, aggregation: 'count', visible: true, style: defaultScalarStyle('int', 'region'),
})
const tr = (id: string, inputs: string[], out?: string): TransformSpec => ({
  id, name: id, inputs: inputs.map((d) => ({ datasetId: d, alias: d })), outputs: [{ key: 'o1', name: id, sql: 'SELECT 1', ...(out ? { outputId: out } : {}) }],
})
// plants (missing) → join (with counties) → joined (missing) → summary → sums (here); counties → other → mine (here)
const doc: WorkspaceDoc = {
  name: 'W',
  datasetIds: ['plants', 'counties', 'joined', 'sums', 'mine'],
  transforms: [tr('summary', ['joined'], 'sums'), tr('join', ['plants', 'counties'], 'joined'), tr('other', ['counties'], 'mine'), tr('remake', ['counties'], 'gone-output')],
  visualizations: [viz('v-plants', 'plants'), viz('v-joined', 'joined'), viz('v-sums', 'sums'), viz('v-mine', 'mine')],
  unavailable: { plants: { name: 'plants', rows: 412, why: 'elsewhere' } },
}
const present = (id: string) => ['counties', 'sums', 'mine'].includes(id)

describe('unavailable items', () => {
  it('finds the missing roots and everything waiting on them', () => {
    const u = unavailability(doc, present)
    expect(u.roots).toEqual(['plants'])
    expect([...u.datasets.keys()].sort()).toEqual(['joined', 'plants'])
    expect([...u.transforms.keys()].sort()).toEqual(['join', 'summary'])
    expect([...u.visualizations.keys()].sort()).toEqual(['v-joined', 'v-plants'])
    expect(u.transforms.get('summary')).toEqual(['plants'])
    // A missing output a runnable transform writes isn't a root: Run makes it.
    expect(u.datasets.has('gone-output')).toBe(false)
  })

  it('replaces a missing dataset everywhere it is pointed at', () => {
    const r = replaceDataset(doc, 'plants', 'new')
    if (!r.ok) throw new Error()
    expect(r.doc.datasetIds[0]).toBe('new')
    expect(r.doc.transforms.find((t) => t.id === 'join')!.inputs[0].datasetId).toBe('new')
    expect(r.doc.visualizations[0].datasetId).toBe('new')
    expect(r.doc.unavailable).toBeUndefined()
    expect(unavailability(r.doc, (id) => id === 'new' || present(id)).roots).toEqual([])
    // Replacing with a dataset already listed doesn't list it twice.
    const dup = replaceDataset(doc, 'plants', 'counties')
    if (!dup.ok) throw new Error()
    expect(dup.doc.datasetIds.filter((d) => d === 'counties')).toHaveLength(1)
  })

  it('removes what did not load, keeping runnable transforms', () => {
    const r = removeUnavailable(doc, present)
    if (!r.ok) throw new Error()
    expect(r.doc.datasetIds).toEqual(['counties', 'sums', 'mine'])
    expect(r.doc.transforms.map((t) => t.id)).toEqual(['other', 'remake'])
    expect(r.doc.visualizations.map((v) => v.id)).toEqual(['v-sums', 'v-mine'])
    expect(r.doc.unavailable).toBeUndefined()
  })

  it('orders the transforms downstream of a dataset, inputs first', () => {
    expect(downstreamOrder(doc, 'plants')).toEqual(['join', 'summary'])
    expect(downstreamOrder(doc, 'counties')).toEqual(['join', 'summary', 'other', 'remake'])
  })
})

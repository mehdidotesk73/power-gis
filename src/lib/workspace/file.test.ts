import { describe, expect, it } from 'vitest'
import { fromWorkspaceFile, parseDraft, parseWorkspaceFile, snapshot, toWorkspaceFile } from './file'
import { defaultScalarStyle, ROWS, type VisualizationSpec } from '../dataset/visualization'
import type { WorkspaceDoc } from './workspace'

const viz = (id: string, datasetId: string): VisualizationSpec => ({
  kind: 'scalar',
  id,
  name: `viz ${id}`,
  datasetId,
  binding: { kind: 'boundary', column: 'fips', boundary: 'us-counties' },
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
    { id: 't1', name: 'Points', sql: 'SELECT * FROM a', inputs: [{ datasetId: 'a', alias: 'a' }], outputId: 'b' },
    { id: 't2', name: 'Join', sql: 'SELECT * FROM a JOIN b USING (k)', inputs: [{ datasetId: 'a', alias: 'a' }, { datasetId: 'b', alias: 'b' }] },
  ],
}

describe('workspace files', () => {
  it('round-trips pointers and settings, never rows', () => {
    const text = JSON.stringify(toWorkspaceFile(doc))
    const r = parseWorkspaceFile(text)
    if (!r.ok) throw new Error(r.error)
    expect(r.file).toMatchObject({ format: 'powergis-workspace', version: 1, workspaceId: 'w1', name: 'Grid', datasetIds: ['a', 'b'] })
    expect(r.file.visualizations[0]).toEqual({ name: 'viz v1', datasetId: 'a', settings: expect.objectContaining({ column: ROWS, kind: 'scalar' }) })
    expect(r.file.visualizations[0]).not.toHaveProperty('id')
  })

  it('rejects files that are not workspaces, with a reason', () => {
    expect(parseWorkspaceFile('{')).toEqual({ ok: false, error: 'This file is not valid JSON.' })
    expect(parseWorkspaceFile('{"type":"FeatureCollection"}')).toMatchObject({ ok: false, error: expect.stringContaining('not a PowerGIS') })
    expect(parseWorkspaceFile(JSON.stringify({ ...toWorkspaceFile(doc), version: 9 }))).toMatchObject({ ok: false, error: expect.stringContaining('version 9') })
    const broken = { ...toWorkspaceFile(doc), visualizations: [{ name: 'x', datasetId: 'a', settings: { kind: 'scalar' } }] }
    expect(parseWorkspaceFile(JSON.stringify(broken))).toMatchObject({ ok: false, error: expect.stringContaining('damaged') })
  })

  it('loads into the current workspace, dropping datasets the database lacks', () => {
    const file = toWorkspaceFile(doc)
    const { doc: d, missing } = fromWorkspaceFile(file, { id: 'w9', name: 'Other', datasetIds: [], visualizations: [], transforms: [] }, (id) => id === 'a')
    expect(missing).toEqual(['b'])
    expect(d).toMatchObject({ id: 'w9', name: 'Grid', datasetIds: ['a'] })
    expect(d.visualizations).toHaveLength(1)
    expect(d.visualizations[0]).toMatchObject({ name: 'viz v1', datasetId: 'a', column: ROWS })
    expect(d.visualizations[0].id).not.toBe('v1') // fresh ids: never collide with another workspace's records
    // Transforms need all their inputs here; an output pointer to a missing dataset is dropped.
    expect(d.transforms).toHaveLength(1)
    expect(d.transforms[0]).toMatchObject({ name: 'Points', inputs: [{ datasetId: 'a', alias: 'a' }], outputId: undefined })
    expect(d.transforms[0].id).not.toBe('t1')
    const all = fromWorkspaceFile(file, doc, () => true).doc
    expect(all.transforms.map((t) => [t.name, t.outputId])).toEqual([['Points', 'b'], ['Join', undefined]])
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
    const broken = { ...toWorkspaceFile(doc), transforms: [{ name: 'x', sql: 1, inputs: [] }] }
    expect(parseWorkspaceFile(JSON.stringify(broken))).toMatchObject({ ok: false, error: expect.stringContaining('transform') })
  })
})

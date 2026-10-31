import { describe, expect, it } from 'vitest'
import { readStory, remapStory, snapshotChanged, snapshotOf, storyDatasets, words, type Story } from './story'
import { fromWorkspaceFile, parseWorkspaceFile, replaceDatasetIds, snapshot, toWorkspaceFile } from '../workspace/file'
import { filesDocument, documentFiles } from '../workspace/files'
import { addStory, emptyWorkspace, removeStory, updateStory, type WorkspaceDoc } from '../workspace/workspace'
import { defaultScalarStyle, ROWS, type VisualizationSpec } from '../dataset/visualization'
import { fingerprint } from '../workspace/fingerprint'

const viz: VisualizationSpec = {
  kind: 'scalar',
  id: 'v1',
  name: 'Score',
  datasetId: 'b',
  binding: { kind: 'geometry', column: 'shape' },
  column: ROWS,
  aggregation: 'count',
  visible: true,
  style: defaultScalarStyle('int', 'region'),
}
const { id: _id, visible: _v, ...mapViz } = viz
const story: Story = {
  id: 's1',
  name: 'How the score is made',
  visualizationIds: ['v1'],
  writtenAt: '2026-10-31T00:00:00Z',
  scenes: [
    { id: 'a', title: 'The raw counts', narrative: 'Each row is a county.', about: { kind: 'dataset', id: 'a' }, figures: [{ kind: 'sample', sql: 'SELECT * FROM a', inputs: [{ datasetId: 'a', alias: 'a' }], snapshot: { columns: ['k'], rows: [[1]] } }] },
    { id: 'b', title: 'Joined', narrative: 'Then joined.', about: { kind: 'transform', id: 't1' }, figures: [{ kind: 'chart', chart: 'bar', x: 'k', y: 'n', sql: 'SELECT k, n FROM b', inputs: [{ datasetId: 'b', alias: 'b' }] }] },
    { id: 'c', title: 'The map', narrative: 'And mapped.', about: { kind: 'visualization', id: 'v1' }, figures: [{ kind: 'map', viz: mapViz, hide: ['Guam'] }] },
  ],
}
const doc: WorkspaceDoc = {
  ...emptyWorkspace('W'),
  datasetIds: ['a', 'b'],
  visualizations: [viz],
  transforms: [{ id: 't1', name: 'Join', inputs: [{ datasetId: 'a', alias: 'a' }], outputs: [{ key: 'o', name: 'B', sql: 'SELECT 1', outputId: 'b' }] }],
  stories: [story],
}

describe('stories', () => {
  it('checks what the storyteller writes: words, figures, scenes', () => {
    const errors: string[] = []
    expect(readStory(story, errors)).toEqual(story)
    expect(errors).toEqual([])
    const long = { ...story, scenes: [{ ...story.scenes[0], narrative: 'word '.repeat(130) }] }
    readStory(long, errors)
    expect(errors[0]).toMatch(/130 words; keep it to about 80/)
    const bad: string[] = []
    readStory({ ...story, scenes: [{ title: 'x', narrative: 'y', figures: [{ kind: 'chart', chart: 'radar', x: 'a', sql: 's' }, { kind: 'sample' }, { kind: 'map', viz: {} }] }] }, bad)
    expect(bad).toEqual([
      'scenes[0] "x": at most 2 figures',
      'scenes[0].figures[0].chart must be one of bar, pie, line, scatter, histogram',
      'scenes[0].figures[1]: needs sql (one SELECT)',
    ])
    expect(words('A county’s median income is $52,000 — 3.5% up.')).toBe(8)
  })

  it('snapshots a figure, and tells when its data changed since', () => {
    const snap = snapshotOf(['k', 'n'], [{ k: 'a', n: 1 }, { k: 'b', n: 2 }, { k: 'c', n: 3 }], 2)
    expect(snap).toEqual({ columns: ['k', 'n'], rows: [['a', 1], ['b', 2]] })
    expect(snapshotChanged(snap, snap)).toBe(false)
    expect(snapshotChanged(snap, { ...snap, rows: [['a', 1], ['b', 5]] })).toBe(true)
    expect(snapshotChanged(undefined, snap)).toBe(false)
    expect(storyDatasets(story)).toEqual(['a', 'b'])
  })

  it('are workspace operations, part of what Save stores', () => {
    const empty = { ...doc, stories: undefined }
    const added = addStory(empty, story)
    expect(added.ok && added.doc.stories).toEqual([story])
    expect(addStory(doc, story)).toMatchObject({ ok: false, error: { code: 'duplicate' } })
    const renamed = updateStory(doc, { ...story, name: 'New' })
    expect(renamed.ok && renamed.doc.stories?.[0].name).toBe('New')
    const gone = removeStory(doc, 's1')
    expect(gone.ok && 'stories' in gone.doc).toBe(false)
    expect(snapshot(doc)).not.toBe(snapshot(empty))
  })

  it('travel in documents, zips and the fingerprint, following new ids', async () => {
    const file = toWorkspaceFile(doc, () => undefined)
    expect(file.stories).toEqual([story])
    const parsed = parseWorkspaceFile(JSON.stringify(file))
    expect(parsed.ok && parsed.file.stories).toEqual([story])
    const zipped = filesDocument(documentFiles(file))
    expect(zipped.ok && zipped.file.stories).toEqual([story])
    expect(documentFiles(file).has('stories/s1.json')).toBe(true)
    expect(await fingerprint(file)).not.toBe(await fingerprint({ ...file, stories: undefined }))

    // Opened: visualizations and transforms get fresh ids, and the story follows them.
    const opened = fromWorkspaceFile(file, emptyWorkspace(), () => true).doc
    const s = opened.stories![0]
    expect(s.visualizationIds).toEqual([opened.visualizations[0].id])
    expect(s.scenes[1].about).toEqual({ kind: 'transform', id: opened.transforms[0].id })
    expect(s.scenes[2].about).toEqual({ kind: 'visualization', id: opened.visualizations[0].id })
    // Datasets made under other ids on another device: its figures read those.
    const moved = replaceDatasetIds(file, (id) => (id === 'b' ? 'b2' : undefined)).stories![0]
    expect(storyDatasets(moved)).toEqual(['a', 'b2'])
    expect(remapStory(story, {}).scenes).toEqual(story.scenes)
  })
})

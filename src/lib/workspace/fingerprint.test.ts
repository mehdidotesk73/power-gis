import { describe, expect, it } from 'vitest'
import { fingerprint, workspaceSync } from './fingerprint'
import type { WorkspaceFile } from './file'

const file = (o: Partial<WorkspaceFile> = {}): WorkspaceFile => ({
  format: 'powergis-workspace',
  version: 2,
  name: 'W',
  datasetIds: ['a'],
  datasets: [{ id: 'a', name: 'A', store: 'local', rows: 3, origin: { kind: 'unknown' } }],
  transforms: [],
  visualizations: [],
  ...o,
}) as WorkspaceFile

describe('workspace fingerprint', () => {
  it('is the same for the same setup, whatever changes on its own', async () => {
    const a = await fingerprint(file())
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await fingerprint(file({ exportedAt: '2026-10-30T00:00:00Z', workspaceId: 'x' }))).toBe(a)
    expect(await fingerprint(file({ datasets: [{ id: 'a', name: 'A', store: 'remote', rows: 99, origin: { kind: 'unknown' } }] as never }))).toBe(a)
  })
  it('changes with the setup', async () => {
    const a = await fingerprint(file())
    expect(await fingerprint(file({ name: 'W2' }))).not.toBe(a)
    expect(await fingerprint(file({ datasetIds: ['a', 'b'] }))).not.toBe(a)
    expect(await fingerprint(file({ datasets: [{ id: 'a', name: 'Renamed', store: 'local', rows: 3, origin: { kind: 'unknown' } }] as never }))).not.toBe(a)
  })
})

describe('workspace sync state', () => {
  const last = { user: 'u', cloud: 'c1', local: 'l1' }
  it('says who changed since the last sync', () => {
    expect(workspaceSync({ cloud: 'c1', local: 'l1' }, last, 'u')).toBe('synced')
    expect(workspaceSync({ cloud: 'c1', local: 'l2' }, last, 'u')).toBe('ahead')
    expect(workspaceSync({ cloud: 'c2', local: 'l1' }, last, 'u')).toBe('behind')
    expect(workspaceSync({ cloud: 'c2', local: 'l2' }, last, 'u')).toBe('both')
  })
  it('is new without a sync for this account (unless both already agree)', () => {
    expect(workspaceSync({ cloud: 'c', local: 'l' }, null, 'u')).toBe('new')
    expect(workspaceSync({ cloud: 'c', local: 'l' }, { ...last, user: 'other' }, 'u')).toBe('new')
    expect(workspaceSync({ cloud: 'same', local: 'same' }, null, 'u')).toBe('synced')
  })
})

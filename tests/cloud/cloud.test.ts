// Integration tests: the real cloud code (server/cloud.ts) against a real
// Supabase stack — Postgres with our schema and row-level security, Auth,
// the REST API and Storage — started locally by `supabase start` (see
// tests/cloud/README.md). Three real accounts, each device its own server and
// database, sending the same requests the app sends. `npm run test:cloud`.
import { beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createServer } from '../../src/server/server'
import { supabaseCloud } from '../../src/server/cloud'
import { nodeDuckDb } from '../../src/server/testEngine'
import { MemoryDatabase } from '../../src/shared/database'
import { emptyWorkspace } from '../../src/lib/workspace/workspace'
import { toWorkspaceFile } from '../../src/lib/workspace/file'
import type { ApiResult } from '../../src/shared/api'

const url = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321'
const key = process.env.SUPABASE_TEST_KEY ?? ''
const run = Math.random().toString(36).slice(2, 8)

const data = <T,>(r: ApiResult<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}
const file = (name: string, text: string) => ({ name, text: async () => text }) as unknown as File

/** A new account (confirmations are off on the local stack), signed in. */
async function account(name: string) {
  const email = `${name}-${run}@example.com`
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: d, error } = await sb.auth.signUp({ email, password: 'test-password-1' })
  if (error || !d.session) throw new Error(`sign up ${email}: ${error?.message ?? 'no session (are confirmations on?)'}`)
  return { name, email, id: d.user!.id, token: d.session.access_token }
}
/** One device: its own database and server, signed in as `who`. */
async function device(who: { token: string }) {
  const db = new MemoryDatabase()
  const server = createServer(db, { readBuiltin: async () => [], sql: nodeDuckDb, cloud: (t) => supabaseCloud(t, { url, key }) })
  data(await server.handle('setAuth', { accessToken: who.token }))
  return { db, server }
}
type Device = Awaited<ReturnType<typeof device>>
const status = async (d: Device, id: string) => data(await d.server.handle('cloudStatus', { items: [{ id }] })).datasets[0]
/** Rewrites a dataset in place (a transform writing into it): its value column `col` times `by`. */
const rewrite = (d: Device, id: string, by: number, col = 'p') =>
  d.server.handle('runTransform', {
    transform: { id: `t-${by}`, name: 'Scale', inputs: [{ datasetId: id, alias: 'src' }], outputs: [{ key: 'o', name: 'scaled', sql: `SELECT fips, ${col} * ${by} AS ${col} FROM src`, outputId: id }] },
  })
const rows = async (d: Device, id: string) => d.db.readRows((await d.db.get('datasets', id))!.table)

let alice: Awaited<ReturnType<typeof account>>, bob: typeof alice, carol: typeof alice
beforeAll(async () => {
  if (!key) throw new Error('Set SUPABASE_TEST_KEY to the local stack\'s publishable (or anon) key: `npx supabase status -o env`')
  ;[alice, bob, carol] = await Promise.all([account('alice'), account('bob'), account('carol')])
})

describe('cloud datasets on a real Supabase stack', () => {
  it('links, pulls on a second device, pushes, pulls, and stops a push over a newer version', async () => {
    const a1 = await device(alice)
    const a2 = await device(alice)
    const id = data(await a1.server.handle('uploadDataset', { source: { kind: 'csv', file: file('prices.csv', 'fips,p\n01001,5\n01003,7\n') } })).datasetId
    const { cloudId } = data(await a1.server.handle('linkToCloud', { id }))
    expect(cloudId).toBe(id)
    expect(await status(a1, id)).toMatchObject({ state: 'synced', canPush: true })

    // The second device opens a document pointing at it: pulled from the cloud.
    const onA1 = (await a1.db.get('datasets', id))!
    const doc = toWorkspaceFile({ ...emptyWorkspace('W'), datasetIds: [id] }, (x) => (x === id ? onA1 : undefined))
    expect(doc.datasets[0]).toMatchObject({ store: 'remote', cloudId })
    expect(data(await a2.server.handle('openDocument', { file: doc })).missing).toEqual([])
    expect(await rows(a2, id)).toEqual([{ fips: '01001', p: 5 }, { fips: '01003', p: 7 }])

    // Changed on the first device: ↑ there; pushed: ↓ on the second, which pulls it.
    data(await rewrite(a1, id, 10))
    expect((await status(a1, id)).state).toBe('ahead')
    data(await a1.server.handle('pushDataset', { id }))
    expect((await status(a2, id)).state).toBe('behind')
    data(await a2.server.handle('pullDataset', { id }))
    expect((await rows(a2, id)).map((r) => r.p)).toEqual([50, 70])

    // Both change it: the second push is a conflict until overwritten.
    data(await rewrite(a1, id, 2))
    data(await rewrite(a2, id, 3))
    data(await a1.server.handle('pushDataset', { id }))
    expect((await status(a2, id)).state).toBe('both')
    expect(await a2.server.handle('pushDataset', { id })).toMatchObject({ ok: false, error: { code: 'conflict' } })
    data(await a2.server.handle('pushDataset', { id, overwrite: true }))
    data(await a1.server.handle('pullDataset', { id }))
    expect((await rows(a1, id)).map((r) => r.p)).toEqual([150, 210])

    // A rename travels with the next push.
    data(await a1.server.handle('updateDataset', { id, name: 'Prices, renamed' }))
    expect((await status(a1, id)).state).toBe('ahead')
    data(await a1.server.handle('pushDataset', { id }))
    data(await a2.server.handle('pullDataset', { id }))
    expect((await a2.db.get('datasets', id))!.name).toBe('Prices, renamed')
  })

  it('shares by email: readers pull, writers push and share, the rules hold in the database too', async () => {
    const a = await device(alice)
    const b = await device(bob)
    const c = await device(carol)
    const id = data(await a.server.handle('uploadDataset', { source: { kind: 'csv', file: file('rates.csv', 'fips,r\n01001,1\n') } })).datasetId
    data(await a.server.handle('linkToCloud', { id }))

    // Bob sees nothing until it's shared, then adds it as a linked copy.
    expect(data(await b.server.handle('cloudDatasets', {})).datasets.map((d) => d.cloudId)).not.toContain(id)
    expect(await a.server.handle('shareDataset', { id, email: `nobody-${run}@example.com`, access: 'read' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('No account') } })
    const shared = data(await a.server.handle('shareDataset', { id, email: bob.email.toUpperCase(), access: 'read' }))
    expect(shared.members.map((m) => [m.email, m.access])).toEqual(expect.arrayContaining([[alice.email, 'owner'], [bob.email, 'read']]))
    expect(shared.members.find((m) => m.email === bob.email)?.name).toBe(`bob-${run}`) // the profile's name: the email's first part
    const listed = data(await b.server.handle('cloudDatasets', {})).datasets.find((d) => d.cloudId === id)
    expect(listed).toMatchObject({ name: 'rates', rows: 1, access: 'read' })
    expect(data(await b.server.handle('addFromCloud', { cloudId: id }))).toEqual({ datasetId: id, created: true })
    expect(await rows(b, id)).toEqual([{ fips: '01001', r: 1 }])

    // Reading: no push — refused by the server, and by the database when asked directly.
    expect((await status(b, id)).canPush).toBe(false)
    expect(await b.server.handle('pushDataset', { id, overwrite: true })).toMatchObject({ ok: false })
    const bobsCloud = supabaseCloud(bob.token, { url, key })
    const details = { id, name: 'rates', description: '', columns: [], rowCount: 0, meta: {} }
    await expect(bobsCloud.putDataset(details, new Uint8Array([1]))).rejects.toThrow()
    await expect(bobsCloud.deleteDataset(id)).rejects.toThrow()

    // Write access: Bob pushes; Alice sees ↓. Bob shares with Carol and manages her while she only reads.
    data(await a.server.handle('setMemberAccess', { id, userId: bob.id, access: 'write' }))
    expect((await status(b, id)).canPush).toBe(true)
    data(await rewrite(b, id, 4, 'r'))
    data(await b.server.handle('pushDataset', { id }))
    expect((await status(a, id)).state).toBe('behind')
    data(await b.server.handle('shareDataset', { id, email: carol.email, access: 'read' }))
    data(await b.server.handle('setMemberAccess', { id, userId: carol.id, access: 'write' }))
    // Carol writes now: Bob can't lower or remove her, and the database refuses it too.
    expect(await b.server.handle('removeMember', { id, userId: carol.id })).toMatchObject({ ok: false })
    await expect(bobsCloud.removeAccess(id, carol.id)).rejects.toThrow()
    await expect(bobsCloud.setAccess(id, carol.id, 'read')).rejects.toThrow()
    await expect(bobsCloud.removeAccess(id, alice.id)).rejects.toThrow()

    // Carol adds it, then leaves: her copy stays, local only.
    data(await c.server.handle('addFromCloud', { cloudId: id }))
    expect((await rows(c, id)).map((r) => r.r)).toEqual([4])
    expect(data(await c.server.handle('removeMember', { id, userId: carol.id }))).toEqual({ members: [], left: true })
    expect((await c.db.get('datasets', id))!.link).toBeUndefined()
    expect(data(await c.server.handle('cloudDatasets', {})).datasets.map((d) => d.cloudId)).not.toContain(id)

    // The owner deletes it from the cloud: Bob's copy reads "gone", and stays.
    data(await a.server.handle('deleteFromCloud', { id }))
    expect((await status(b, id)).state).toBe('gone')
    expect(await rows(b, id)).toEqual([{ fips: '01001', r: 4 }])
  })

  it("keeps several workspaces per account, each to its owner", async () => {
    const a1 = await device(alice)
    const a2 = await device(alice)
    const b = await device(bob)
    const doc = (name: string) => toWorkspaceFile(emptyWorkspace(name), () => undefined)
    const first = data(await a1.server.handle('saveCloudWorkspace', { file: doc('Alice’s map'), overview: 'nothing yet' }))
    const second = data(await a1.server.handle('saveCloudWorkspace', { file: doc('Alice’s second map'), overview: '' }))
    if ('gone' in first || 'gone' in second) throw new Error('not saved')
    expect(second.id).not.toBe(first.id)
    // Another device of hers lists both (most recent first) and reads either; Bob sees none of them.
    const list = data(await a2.server.handle('cloudWorkspaces', {})).workspaces
    expect(list.map((w) => w.name)).toEqual(['Alice’s second map', 'Alice’s map'])
    expect(data(await a2.server.handle('cloudWorkspace', { id: first.id })).workspace).toMatchObject({ name: 'Alice’s map' })
    expect(data(await b.server.handle('cloudWorkspaces', {})).workspaces).toEqual([])
    expect(data(await b.server.handle('cloudWorkspace', { id: first.id })).workspace).toBeNull()
    // Bob can't overwrite or delete hers: his save reads as gone, his delete changes nothing.
    expect(data(await b.server.handle('saveCloudWorkspace', { id: first.id, file: doc('Bob was here'), overview: '' }))).toEqual({ gone: true })
    data(await b.server.handle('deleteCloudWorkspace', { id: first.id }))
    expect(data(await a2.server.handle('cloudWorkspace', { id: first.id })).workspace).toMatchObject({ name: 'Alice’s map' })
    // She replaces one in place, and deletes the other.
    const again = data(await a2.server.handle('saveCloudWorkspace', { id: first.id, file: doc('Alice’s map, renamed'), overview: '' }))
    expect(again).toMatchObject({ id: first.id })
    data(await a2.server.handle('deleteCloudWorkspace', { id: second.id }))
    expect(data(await a1.server.handle('cloudWorkspaces', {})).workspaces.map((w) => w.name)).toEqual(['Alice’s map, renamed'])
  })
})

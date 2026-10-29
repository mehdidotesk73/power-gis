// The server's cloud store: Supabase, as the signed-in user. The page hands
// the worker the session's access token (setAuth); every query runs with it,
// so the database's row-level security sees that user.
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_KEY, SUPABASE_URL } from '../shared/supabaseConfig'
import { cloudFilePath as filePath, DATASET_FILE, type Access, type CloudDataset, type CloudMember, type CloudStore } from '../shared/cloud'

/** The user the token is for (its `sub`), to tell which datasets they own. */
function tokenUser(token: string): string | undefined {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return (JSON.parse(atob(part)) as { sub?: string }).sub
  } catch {
    return undefined
  }
}

const BUCKET = 'datasets'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLUMNS = 'id, name, description, columns, row_count, meta, file_path, size_bytes, created_by, updated_at'
type Row = { id: string; name: string; description: string; columns: unknown; row_count: number; meta: unknown; file_path: string | null; size_bytes: number | null; created_by: string | null; updated_at: string }

export function supabaseCloud(accessToken: string, project = { url: SUPABASE_URL, key: SUPABASE_KEY }): CloudStore {
  const sb = createClient(project.url, project.key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const check = <T>(r: { data: T; error: { message: string } | null }): T => {
    if (r.error) throw new Error(r.error.message)
    return r.data
  }
  const me = tokenUser(accessToken)
  const asDataset = (r: Row): CloudDataset => ({
    id: r.id,
    name: r.name,
    description: r.description,
    columns: Array.isArray(r.columns) ? (r.columns as CloudDataset['columns']) : [],
    rowCount: Number(r.row_count),
    meta: (r.meta ?? {}) as CloudDataset['meta'],
    updatedAt: r.updated_at,
    ...(r.size_bytes !== null ? { sizeBytes: Number(r.size_bytes) } : {}),
    hasFile: !!r.file_path,
    access: !!me && r.created_by === me ? 'owner' : 'read',
  })
  /** Fills in the user's own access (owner / write / read: who may push) from their access rows. */
  async function withAccess(rows: CloudDataset[]): Promise<CloudDataset[]> {
    if (me && rows.length) {
      const mine = check(await sb.from('dataset_access').select('dataset_id, access').in('dataset_id', rows.map((r) => r.id)).eq('user_id', me)) as { dataset_id: string; access: Access }[]
      for (const r of rows) r.access = mine.find((a) => a.dataset_id === r.id)?.access ?? r.access
    }
    return rows
  }
  return {
    async datasets(ids) {
      // Cloud ids are uuids: anything else (a readable id from a document) can't be there, and would fail the query.
      ids = ids.filter((id) => UUID.test(id))
      if (!ids.length) return []
      return withAccess((check(await sb.from('datasets').select(COLUMNS).in('id', ids)) as Row[]).map(asDataset))
    },
    async listDatasets() {
      // Row-level security answers only what the user may see.
      return withAccess((check(await sb.from('datasets').select(COLUMNS).order('updated_at', { ascending: false })) as Row[]).map(asDataset))
    },
    async members(id) {
      const rows = check(await sb.rpc('dataset_members', { ds: id })) as { user_id: string; email: string; display_name: string | null; access: Access }[]
      return rows.map((r): CloudMember => ({ userId: r.user_id, email: r.email, name: r.display_name || r.email, access: r.access, ...(r.user_id === me ? { you: true } : {}) }))
    },
    async share(id, email, access) {
      const found = (check(await sb.rpc('find_user_by_email', { lookup: email })) as { id: string }[])[0]
      if (!found) throw new Error(`No account uses ${email.trim()}: they need to create one first (☰ → Sign in)`)
      const ins = await sb.from('dataset_access').insert({ dataset_id: id, user_id: found.id, access, granted_by: me })
      // Already has access: change it instead.
      if (ins.error?.code === '23505') return this.setAccess(id, found.id, access)
      if (ins.error) throw new Error(ins.error.message)
    },
    async setAccess(id, userId, access) {
      const rows = check(await sb.from('dataset_access').update({ access }).eq('dataset_id', id).eq('user_id', userId).select('user_id')) as unknown[]
      // Row-level security skips a row the user may not change, without an error.
      if (!rows.length) throw new Error("You can't change that person's access")
    },
    async removeAccess(id, userId) {
      const rows = check(await sb.from('dataset_access').delete().eq('dataset_id', id).eq('user_id', userId).select('user_id')) as unknown[]
      if (!rows.length) throw new Error("You can't remove that person's access")
    },
    async putDataset(d, file) {
      if (!UUID.test(d.id)) throw new Error(`"${d.name}" has an id the cloud can't keep (${d.id}); make a local copy first`)
      const have = check(await sb.from('datasets').select('id').eq('id', d.id).maybeSingle())
      if (!have) check(await sb.from('datasets').insert({ id: d.id, name: d.name, description: d.description, columns: d.columns, row_count: d.rowCount, meta: d.meta }))
      const up = await sb.storage.from(BUCKET).upload(filePath(d.id), new Blob([file], { type: DATASET_FILE.contentType }), { upsert: true, contentType: DATASET_FILE.contentType })
      if (up.error) {
        // A dataset made just now without its file would read as empty elsewhere: take it back out.
        if (!have) await sb.from('datasets').delete().eq('id', d.id)
        throw new Error(up.error.message)
      }
      const row = check(
        await sb
          .from('datasets')
          .update({ name: d.name, description: d.description, columns: d.columns, row_count: d.rowCount, meta: d.meta, file_path: filePath(d.id), size_bytes: file.byteLength })
          .eq('id', d.id)
          .select('updated_at')
          .single(),
      )
      if (!row) throw new Error("The dataset was not saved")
      return { updatedAt: row.updated_at }
    },
    async readFile(id) {
      const r = await sb.storage.from(BUCKET).download(filePath(id))
      if (r.error || !r.data) throw new Error(r.error?.message ?? 'The dataset has no file in the cloud')
      return new Uint8Array(await r.data.arrayBuffer())
    },
    async deleteDataset(id) {
      // The file first: its delete policy reads the access rows, which go with the dataset row.
      const r = await sb.storage.from(BUCKET).remove([filePath(id)])
      if (r.error) throw new Error(r.error.message)
      // Row-level security skips a dataset the user may not delete without an error: none back = refused.
      const rows = check(await sb.from('datasets').delete().eq('id', id).select('id')) as unknown[]
      if (!rows.length) throw new Error('Only its owner can delete it from the cloud')
    },
    async defaultWorkspace() {
      const row = check(await sb.from('workspaces').select('id, name, config, updated_at').eq('is_default', true).maybeSingle())
      return row ? { id: row.id, name: row.name, file: row.config as unknown, updatedAt: row.updated_at } : null
    },
    async saveDefaultWorkspace({ name, file, overview }) {
      const have = check(await sb.from('workspaces').select('id').eq('is_default', true).maybeSingle())
      const row = have
        ? check(await sb.from('workspaces').update({ name, config: file, overview }).eq('id', have.id).select('id, updated_at').single())
        : check(await sb.from('workspaces').insert({ name, config: file, overview, is_default: true }).select('id, updated_at').single())
      if (!row) throw new Error('The workspace was not saved')
      return { id: row.id, updatedAt: row.updated_at }
    },
  }
}

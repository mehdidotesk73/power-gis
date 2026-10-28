// The server's cloud store: Supabase, as the signed-in user. The page hands
// the worker the session's access token (setAuth); every query runs with it,
// so the database's row-level security sees that user.
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_KEY, SUPABASE_URL } from '../shared/supabaseConfig'
import type { CloudStore } from '../shared/cloud'
import type { WorkspaceFile } from '../lib/workspace/file'

export function supabaseCloud(accessToken: string): CloudStore {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const check = <T>(r: { data: T; error: { message: string } | null }): T => {
    if (r.error) throw new Error(r.error.message)
    return r.data
  }
  return {
    async defaultWorkspace() {
      const row = check(await sb.from('workspaces').select('id, name, config, updated_at').eq('is_default', true).maybeSingle())
      return row ? { id: row.id, name: row.name, file: row.config as WorkspaceFile, updatedAt: row.updated_at } : null
    },
    async saveDefaultWorkspace({ name, file }) {
      const have = check(await sb.from('workspaces').select('id').eq('is_default', true).maybeSingle())
      const row = have
        ? check(await sb.from('workspaces').update({ name, config: file }).eq('id', have.id).select('id, updated_at').single())
        : check(await sb.from('workspaces').insert({ name, config: file, is_default: true }).select('id, updated_at').single())
      if (!row) throw new Error('The workspace was not saved')
      return { id: row.id, updatedAt: row.updated_at }
    },
  }
}

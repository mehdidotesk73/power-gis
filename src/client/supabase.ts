// The page's Supabase client: accounts (client/auth.ts). The server worker
// makes its own for data, with the signed-in user's token (server/cloud.ts).
// The project's values live in shared/supabaseConfig.ts.
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_KEY, SUPABASE_URL } from '../shared/supabaseConfig'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'powergis.auth' },
})

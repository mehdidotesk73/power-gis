// The Supabase project: accounts today, cloud datasets and workspaces next.
// Both values are public by design: the publishable key ships in the app, and
// the database's row-level security (supabase/schema.sql) is what guards data.
import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = 'https://rorqzjnwqwlyusagzcxy.supabase.co'
const SUPABASE_KEY = 'sb_publishable_ddr8oYy32EprRXhFuaiB3w_tMNUQuIl'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'powergis.auth' },
})

// The Supabase project, for both sides: the page's client (accounts) and the
// server worker's (workspaces, datasets). Both values are public by design:
// the publishable key ships in the app; row-level security guards the data.
// A build can point elsewhere with VITE_SUPABASE_URL / VITE_SUPABASE_KEY (the
// end-to-end tests build against a local stack from `supabase start`).
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
export const SUPABASE_URL = env.VITE_SUPABASE_URL || 'https://rorqzjnwqwlyusagzcxy.supabase.co'
export const SUPABASE_KEY = env.VITE_SUPABASE_KEY || 'sb_publishable_ddr8oYy32EprRXhFuaiB3w_tMNUQuIl'

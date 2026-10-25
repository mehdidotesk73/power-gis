// Read-only access to the database (later: a Supabase client). Writes go
// through server requests (api.ts), never through here.
import type { ReadDatabase } from '../shared/database'
import { IndexedDbDatabase } from '../shared/idb'

export const readDb: ReadDatabase = new IndexedDbDatabase()

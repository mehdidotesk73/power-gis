// Read-only access to the records (later: a Supabase client). Writes, and every
// read of a dataset's rows, go through server requests (api.ts), never through here.
import type { RecordReader } from '../shared/database'
import { IndexedDbDatabase } from '../shared/idb'

export const readDb: RecordReader = new IndexedDbDatabase()

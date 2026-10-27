// The dataset finder: every dataset this user can use. The pickers (＋ Dataset
// → Saved), the default map's seeding and the assistant all list datasets
// through it. Today that's the datasets stored on this device; with the shared
// database it becomes these plus the remote registry's datasets the user may
// access, and every caller gets both.
import { readDb } from './db'
import type { DatasetRecord } from '../shared/records'

export function listDatasets(): Promise<DatasetRecord[]> {
  return readDb.list('datasets')
}

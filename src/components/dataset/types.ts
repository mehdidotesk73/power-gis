import type { BuiltDataset, DatasetSpec } from '../../lib/dataset/dataset'
import type { DatasetMeta } from '../../lib/workspace/workspace'

/** An imported dataset: its spec plus the built (immutable) features and rows. */
export interface LoadedDataset {
  spec: DatasetSpec
  built: BuiltDataset
  meta: DatasetMeta
  /** Dataset-specific extras (custom dashboard, search) keyed by name. */
  preset?: 'utilities'
}

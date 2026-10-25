import type { BuiltDataset, DatasetSpec } from '../../lib/dataset/dataset'

/** An imported dataset: its spec plus the built (immutable) features and rows. */
export interface LoadedDataset {
  spec: DatasetSpec
  built: BuiltDataset
  /** Dataset-specific extras (custom dashboard, search) keyed by name. */
  preset?: 'utilities'
}

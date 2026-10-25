import type { BuiltDatasource, DatasourceSpec } from '../../lib/datasource/datasource'

/** An imported data source: its spec plus the built (immutable) features and rows. */
export interface LoadedDatasource {
  spec: DatasourceSpec
  built: BuiltDatasource
  /** Dataset-specific extras (custom dashboard, search) keyed by name. */
  preset?: 'utilities'
}

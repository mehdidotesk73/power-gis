import type { BuiltSource, SourceLayerSpec } from '../../lib/layers/sourceLayer'

/** A source layer on the map: its editable spec plus the built (immutable) data. */
export interface LoadedSource {
  spec: SourceLayerSpec
  built: BuiltSource
  /** Where the rows came from, for display. */
  origin: string
  /** Dataset-specific extras (custom dashboard, search) keyed by name. */
  preset?: 'utilities'
}

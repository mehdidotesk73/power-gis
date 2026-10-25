// Tables that ship with the app. Uploading one stores a copy in the
// database as an ordinary dataset.

export interface BuiltinTable {
  table: string
  label: string
  /** Attached to the dataset record (e.g. the utilities dashboard and search). */
  extensions?: Record<string, unknown>
}

export const UTILITY_TABLE = 'utility_counties'

export const BUILTIN_TABLES: BuiltinTable[] = [
  { table: UTILITY_TABLE, label: 'Electric utilities by county (EIA-861)', extensions: { preset: 'utilities' } },
  { table: 'utilities', label: 'EIA-861 utility list (no geometry)' },
  { table: 'demo_vectors', label: 'Demo vector field (synthetic)' },
]

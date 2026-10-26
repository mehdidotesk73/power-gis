// Tables that ship with the app. Uploading one stores a copy in the
// database as an ordinary dataset, marked `extensions.builtin = table` and
// `extensions.version` so the default workspace can reuse an existing copy
// instead of uploading again — only while its shape is current.

export interface BuiltinTable {
  table: string
  label: string
  description: string
  /** Where the server reads it: a CSV in public/data, polygons from us-atlas, or generated. */
  source: 'csv' | 'boundary' | 'generated'
  /** Bump when the table's columns or contents change: older stored copies stop being reused. */
  version: number
}

export const BUILTIN_TABLES: BuiltinTable[] = [
  { table: 'us_counties', label: 'US counties', source: 'boundary', version: 1, description: 'County polygons (Census 2017, 1:10m, via us-atlas): fips, name, county, state, state_fips, geometry.' },
  { table: 'us_states', label: 'US states', source: 'boundary', version: 1, description: 'State and territory polygons (Census 2017, 1:10m, via us-atlas): fips, name, abbr, geometry.' },
  { table: 'utilities', label: 'EIA-861 utilities', source: 'csv', version: 2, description: 'One row per electric utility: EIA id, name, ownership type, and customers / sales / revenue totals across its states (EIA-861 2025, via PUDL).' },
  { table: 'utility_counties', label: 'EIA-861 utility ↔ county links', source: 'csv', version: 2, description: 'Many-to-many links: one row per utility per county it serves (utility_id_eia, county_fips).' },
  { table: 'demo_vectors', label: 'Demo vector field (synthetic)', source: 'generated', version: 1, description: 'A synthetic vector field for trying arrows.' },
]

export const builtinTable = (table: string) => BUILTIN_TABLES.find((t) => t.table === table)

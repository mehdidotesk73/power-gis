// Tables that ship with the app. Uploading one stores a copy in the
// database as an ordinary dataset, marked `extensions.builtin = table` so the
// default workspace can reuse an existing copy instead of uploading again.

export interface BuiltinTable {
  table: string
  label: string
  description: string
  /** Where the server reads it: a CSV in public/data, polygons from us-atlas, or generated. */
  source: 'csv' | 'boundary' | 'generated'
}

export const BUILTIN_TABLES: BuiltinTable[] = [
  { table: 'us_counties', label: 'US counties', source: 'boundary', description: 'County polygons (Census 2017, 1:10m, via us-atlas) by 5-digit FIPS code.' },
  { table: 'us_states', label: 'US states', source: 'boundary', description: 'State and territory polygons (Census 2017, 1:10m, via us-atlas) by 2-digit FIPS code.' },
  { table: 'utilities', label: 'EIA-861 utilities', source: 'csv', description: 'One row per electric utility: name, ownership type, states, totals (EIA-861, via PUDL).' },
  { table: 'utility_states', label: 'EIA-861 utility × state', source: 'csv', description: 'One row per utility per state: counties served, customers, sales, revenue.' },
  { table: 'utility_counties', label: 'EIA-861 service territory', source: 'csv', description: 'Join table: one row per utility per county it serves (county_fips).' },
  { table: 'demo_vectors', label: 'Demo vector field (synthetic)', source: 'generated', description: 'A synthetic vector field for trying arrows.' },
]

export const builtinTable = (table: string) => BUILTIN_TABLES.find((t) => t.table === table)

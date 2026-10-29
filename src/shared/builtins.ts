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
  { table: 'county_income', label: 'County income (ACS)', source: 'csv', version: 1, description: 'Census ACS county estimates: median household and per-capita income, aggregate income, households and mean income, each with its margin of error (GEOID = county FIPS). Placeholder values (zero or below) mean not available.' },
  { table: 'county_education', label: 'County education (ACS B15003)', source: 'csv', version: 1, description: 'Census ACS table B15003, educational attainment of people 25 and over, per county: every attainment level as an estimate (_E) and margin of error (_M); GEOID = county FIPS.' },
  { table: 'county_health_insurance', label: 'County health insurance (ACS B27010)', source: 'csv', version: 1, description: 'Census ACS table B27010, health insurance coverage by age, per county: estimates (_E) and margins of error (_M); GEOID = county FIPS.' },
  { table: 'county_home_value', label: 'County home value (ACS B25077, B25075)', source: 'csv', version: 1, description: 'Census ACS tables B25077 (median home value) and B25075 (homes by value band), per county: estimates (_E) and margins of error (_M); GEOID = county FIPS. Placeholders like -666666666 mean not available.' },
  { table: 'county_rent', label: 'County rent (ACS B25064, B25063)', source: 'csv', version: 1, description: 'Census ACS tables B25064 (median gross rent) and B25063 (rentals by rent band), per county: estimates (_E) and margins of error (_M); GEOID = county FIPS.' },
  { table: 'county_columns', label: 'ACS county columns (dictionary)', source: 'csv', version: 1, description: 'What each ACS column in the county tables means: column, meaning, table and universe.' },
  { table: 'utilities', label: 'EIA-861 utilities', source: 'csv', version: 3, description: 'One row per electric utility: EIA id, name, ownership type, short-form filer (EIA-861 2025, via PUDL).' },
  { table: 'utility_counties', label: 'EIA-861 utility ↔ county links', source: 'csv', version: 2, description: 'Many-to-many links: one row per utility per county it serves (utility_id_eia, county_fips).' },
  { table: 'demo_vectors', label: 'Demo vector field (synthetic)', source: 'generated', version: 1, description: 'A synthetic vector field for trying arrows.' },
]

export const builtinTable = (table: string) => BUILTIN_TABLES.find((t) => t.table === table)

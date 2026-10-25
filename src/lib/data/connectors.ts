// Connectors: where tables come from. Every table is read through this one
// interface, so swapping the built-in CSVs for a file on the device, or later
// a database, doesn't touch the map code.
//
//   StaticFileConnector  — CSVs shipped with the app (public/data/<table>.csv)
//   LocalFileConnector   — CSV files the user picks on their device
//   MemoryConnector      — tables already in memory (demo data, parsed GeoJSON/Esri)
//   (database)           — e.g. Supabase: implement DataConnector with
//                          readTable(name) = select * from <name>. Not built yet.
//
// A connector's table plus a geometry binding becomes a *dataset*
// (lib/dataset), which layers then visualize.

import { parseCsv } from './csv'

export type DataRecord = Record<string, unknown>

export interface DataConnector {
  /** Short description for the UI, e.g. "Built-in data" or "utility_counties.csv". */
  readonly label: string
  /** Names of the tables this source can read. */
  listTables(): Promise<string[]>
  /** All rows of a table. Rejects with a readable message if it's missing. */
  readTable(name: string): Promise<DataRecord[]>
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** CSVs served alongside the app, at `${baseUrl}${dir}/<table>.csv`. */
export class StaticFileConnector implements DataConnector {
  readonly label = 'Built-in data'
  constructor(
    private readonly tables: string[],
    private readonly baseUrl = '/',
    private readonly dir = 'data',
    private readonly fetchImpl: FetchLike = (u) => fetch(u),
  ) {}

  async listTables() {
    return [...this.tables]
  }

  async readTable(name: string) {
    if (!this.tables.includes(name)) throw new Error(`No built-in table "${name}"`)
    const res = await this.fetchImpl(`${this.baseUrl}${this.dir}/${name}.csv`)
    if (!res.ok) throw new Error(`${name}.csv: HTTP ${res.status}`)
    return parseCsv(await res.text())
  }
}

/** Anything with a name and text() — a browser File, or a stand-in in tests. */
export interface FileLike {
  name: string
  text(): Promise<string>
}

/**
 * CSV files picked on the device. A file named `<table>.csv` provides that
 * table; a single file of any name can be bound to a table explicitly.
 * Files never leave the browser.
 */
export class LocalFileConnector implements DataConnector {
  private readonly files = new Map<string, FileLike>()

  constructor(files: FileLike[] = [], bindings: Record<string, FileLike> = {}) {
    for (const f of files) this.files.set(f.name.replace(/\.csv$/i, ''), f)
    for (const [table, f] of Object.entries(bindings)) this.files.set(table, f)
  }

  get label() {
    const names = [...new Set([...this.files.values()].map((f) => f.name))]
    return names.length ? names.join(', ') : 'No files chosen'
  }

  async listTables() {
    return [...this.files.keys()]
  }

  async readTable(name: string) {
    const f = this.files.get(name)
    if (!f) throw new Error(`Choose a CSV for "${name}"`)
    return parseCsv(await f.text())
  }
}

/** Tables held in memory — generated data, or features already parsed from a file. */
export class MemoryConnector implements DataConnector {
  constructor(
    readonly label: string,
    private readonly tables: Record<string, DataRecord[]>,
  ) {}

  async listTables() {
    return Object.keys(this.tables)
  }

  async readTable(name: string) {
    const t = this.tables[name]
    if (!t) throw new Error(`No table "${name}"`)
    return t
  }
}

/** Column holding each feature's geometry when features are read as a table. */
export const GEOMETRY_COLUMN = 'geometry'

/**
 * Features (GeoJSON / Esri JSON / ArcGIS REST, already parsed) as table rows:
 * their properties are the columns, plus a `geometry` column.
 */
export function featureTable(features: { geometry: unknown; properties: Record<string, unknown> | null }[]): DataRecord[] {
  return features.map((f) => {
    const props = { ...(f.properties ?? {}) }
    delete props[GEOMETRY_COLUMN] // a property named "geometry" would shadow the real one
    return { ...props, [GEOMETRY_COLUMN]: f.geometry }
  })
}

/** Throws if the records lack any required column — a clear message beats a blank map. */
export function requireColumns(records: DataRecord[], columns: readonly string[], table: string): void {
  if (!records.length) throw new Error(`"${table}" has no rows`)
  const missing = columns.filter((c) => !(c in records[0]))
  if (missing.length) throw new Error(`"${table}" is missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`)
}

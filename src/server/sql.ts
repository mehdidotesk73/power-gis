// Running a transform's SQL. Input datasets are loaded into the SQL engine
// (DuckDB) as tables named by their aliases, with column types mapped from
// ours; the query's result comes back as plain rows with our types.
//
// Type mapping (ours → DuckDB → ours):
//   int → BIGINT, double → DOUBLE, boolean → BOOLEAN, string → VARCHAR,
//   datetime → TIMESTAMP (ISO text back), vector → STRUCT(u, v),
//   point / polyline / region → VARCHAR holding GeoJSON (typed again on the way out).
// Helpers available in SQL: point(lat, lon) → a point geometry; vector(u, v) → a vector.
//
// The engine is anything that runs SQL and returns rows — DuckDB-WASM in the
// browser (duckdb.ts), its Node build in tests.

import type { DataRecord } from '../lib/data/connectors'
import { inferColumns, isGeometryColumn, type ColumnInfo, type ColumnType } from '../lib/dataset/columns'

export interface SqlResult {
  /** Result column names and the engine's type names (Arrow), in order. */
  fields: { name: string; type: string }[]
  rows: DataRecord[]
}
export interface SqlEngine {
  /** Runs one statement. Rejects with the engine's message on error. */
  query(sql: string): Promise<SqlResult>
}

export interface SqlInput {
  alias: string
  /** For messages: what the user calls the dataset. */
  label?: string
  /** Changes whenever the rows change (e.g. dataset id + updatedAt), so loaded tables can be reused. */
  version: string
  columns: ColumnInfo[]
  rows: () => Promise<DataRecord[]>
}

export const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/

const SQL_TYPE: Record<ColumnType, string> = {
  int: 'BIGINT',
  double: 'DOUBLE',
  boolean: 'BOOLEAN',
  datetime: 'TIMESTAMP',
  string: 'VARCHAR',
  vector: 'STRUCT(u DOUBLE, v DOUBLE)',
  point: 'VARCHAR',
  polyline: 'VARCHAR',
  region: 'VARCHAR',
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`
const str = (s: string) => `'${s.replace(/'/g, "''")}'`

/** A cell as a SQL literal of its column's type. */
function literal(v: unknown, type: ColumnType): string {
  if (v === null || v === undefined || v === '') return 'NULL'
  switch (type) {
    case 'int':
    case 'double': {
      const n = Number(v)
      return Number.isFinite(n) ? String(n) : 'NULL'
    }
    case 'boolean':
      return v === true || /^(true|1)$/i.test(String(v)) ? 'TRUE' : 'FALSE'
    case 'datetime': {
      const d = new Date(String(v))
      return Number.isNaN(d.getTime()) ? 'NULL' : `TIMESTAMP ${str(d.toISOString())}`
    }
    case 'vector': {
      const o = v as { u?: unknown; v?: unknown }
      const u = Number(o?.u)
      const w = Number(o?.v)
      return Number.isFinite(u) && Number.isFinite(w) ? `{'u': ${u}, 'v': ${w}}` : 'NULL'
    }
    default:
      return str(isGeometryColumn(type) && typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
}

const MACROS = [
  // Latitude first, as people say coordinates; GeoJSON stores longitude first.
  `CREATE OR REPLACE MACRO point(lat, lon) AS CASE WHEN lon IS NULL OR lat IS NULL THEN NULL ELSE '{"type":"Point","coordinates":[' || CAST(lon AS DOUBLE) || ',' || CAST(lat AS DOUBLE) || ']}' END`,
  `CREATE OR REPLACE MACRO vector(u, v) AS CASE WHEN u IS NULL OR v IS NULL THEN NULL ELSE {'u': CAST(u AS DOUBLE), 'v': CAST(v AS DOUBLE)} END`,
]

/** A result value as plain data: BigInts → numbers, timestamps → ISO text, structs recursively. */
function plain(v: unknown, type: string): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return Number(v)
  if (/^(Timestamp|Date)/.test(type) && (typeof v === 'number' || v instanceof Date)) return new Date(v as number).toISOString()
  if (Array.isArray(v)) return v.map((x) => plain(x, ''))
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x, '')]))
  return v
}

/** One SELECT (or WITH … SELECT) statement, trailing semicolon trimmed; anything else is rejected with a reason. */
export function checkSelect(sql: string): string {
  const s = sql.trim().replace(/;\s*$/, '').trim()
  if (!s) throw new Error('The SQL is empty')
  if (/;\s*\S/.test(s.replace(/'[^']*'/g, "''"))) throw new Error('Write one SELECT statement (no semicolons between statements)')
  if (!/^(select|with|from)\b/i.test(s.replace(/^(--[^\n]*\n|\s)+/, ''))) throw new Error('A transform is one SELECT query (it may start with WITH)')
  return s
}

export function createSqlRunner(engine: () => Promise<SqlEngine>) {
  const loaded = new Map<string, string>() // alias → version
  let ready: Promise<SqlEngine> | null = null

  async function connect() {
    ready ??= (async () => {
      const e = await engine()
      for (const m of MACROS) await e.query(m)
      return e
    })().catch((err) => {
      ready = null
      throw err
    })
    return ready
  }

  async function load(e: SqlEngine, input: SqlInput) {
    if (!ALIAS.test(input.alias)) throw new Error(`"${input.alias}" can't be a table name: use letters, digits and _ (not starting with a digit)`)
    if (loaded.get(input.alias) === input.version) return
    const cols = input.columns
    await e.query(`CREATE OR REPLACE TABLE ${ident(input.alias)} (${cols.map((c) => `${ident(c.name)} ${SQL_TYPE[c.type]}`).join(', ')})`)
    const rows = await input.rows()
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500).map((r) => `(${cols.map((c) => literal(r[c.name], c.type)).join(', ')})`)
      await e.query(`INSERT INTO ${ident(input.alias)} VALUES ${batch.join(', ')}`)
    }
    loaded.set(input.alias, input.version)
  }

  /** Runs a SELECT over the inputs. `limit` caps the rows returned (previews); the full count comes back too. */
  async function run(sql: string, inputs: SqlInput[], limit?: number): Promise<{ columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number }> {
    const query = checkSelect(sql)
    const aliases = inputs.map((i) => i.alias)
    const dup = aliases.find((a, i) => aliases.indexOf(a) !== i)
    if (dup) throw new Error(`Two inputs are both called "${dup}"`)
    const e = await connect()
    for (const input of inputs) await load(e, input)
    let res: SqlResult
    try {
      res = await e.query(limit === undefined ? query : `SELECT * FROM (${query}) LIMIT ${Math.max(0, Math.floor(limit))}`)
    } catch (err) {
      // An unknown table is almost always a name that isn't one of the inputs' table names: list them.
      const missing = /Table with name (\S+) does not exist/.exec((err as Error).message)
      if (missing) {
        const have = inputs.map((i) => (i.label ? `${i.alias} (${i.label})` : i.alias)).join(', ')
        throw new Error(`No table ${missing[1]}. Tables you can use: ${have}.`)
      }
      throw err
    }
    const rows = res.rows.map((r) => Object.fromEntries(res.fields.map((f) => [f.name, plain(r[f.name], f.type)])))
    const rowCount = limit === undefined ? rows.length : Number((await e.query(`SELECT count(*) AS n FROM (${query})`)).rows[0].n)
    // Our types from the values (GeoJSON text → geometry, {u, v} → vector, ISO text → datetime);
    // columns with no values fall back to the engine's type.
    const inferred = new Map(inferColumns(rows).map((c) => [c.name, c.type]))
    const columns = res.fields.map((f) => ({ name: f.name, type: rows.some((r) => r[f.name] !== null) ? (inferred.get(f.name) ?? 'string') : fromEngineType(f.type) }))
    return { columns, rows, rowCount }
  }

  return { run }
}

function fromEngineType(t: string): ColumnType {
  if (/^(Int|Uint)/.test(t)) return 'int'
  if (/^(Float|Decimal)/.test(t)) return 'double'
  if (/^Bool/.test(t)) return 'boolean'
  if (/^(Timestamp|Date)/.test(t)) return 'datetime'
  if (/^Struct<\{u:.*v:/.test(t)) return 'vector'
  return 'string'
}

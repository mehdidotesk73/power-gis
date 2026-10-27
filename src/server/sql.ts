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
  /** Bulk-loads plain columns into a new table (Arrow). Engines without it get INSERT … VALUES. */
  insert?(table: string, columns: StagedColumn[]): Promise<void>
}

/** One column of plain values for a bulk load; sql.ts casts it to its final type afterwards. */
export interface StagedColumn {
  name: string
  kind: 'double' | 'bool' | 'text'
  values: (number | boolean | string | null)[]
}

export interface SqlInput {
  alias: string
  /** Which dataset this is (one engine copy each, whatever alias a query uses); defaults to the alias. */
  key?: string
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
  // DECIMAL / HUGEINT (e.g. sum() of a BIGINT) arrive as Arrow big numbers whose text is the
  // unscaled integer; the type ("Decimal[38e0]", "Decimal[10e+3]") carries the scale.
  const dec = /^Decimal\[\d+e([+-]?\d+)\]/.exec(type)
  if (dec && typeof v === 'object') return Number(String(v)) / 10 ** Number(dec[1])
  if (/^(Timestamp|Date)/.test(type) && (typeof v === 'number' || v instanceof Date)) return new Date(v as number).toISOString()
  if (Array.isArray(v)) return v.map((x) => plain(x, ''))
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x, '')]))
  return v
}

/** One SELECT (or WITH … SELECT) statement, trailing semicolon trimmed; anything else is rejected with a reason. */
export function checkSelect(sql: string): string {
  let s = sql.trim()
  if (!s) throw new Error('The SQL is empty')
  // Strings and comments may hold anything (a ";", a "don't"): blank them out,
  // keeping positions, to look at the code alone.
  const code = s.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? `'${' '.repeat(m.length - 2)}'` : ' '.repeat(m.length)))
  const end = /;\s*$/.exec(code)
  if (end) s = s.slice(0, end.index) + s.slice(end.index + 1)
  if (/;\s*\S/.test(code.slice(0, end?.index))) throw new Error('Write one SELECT statement (no semicolons between statements)')
  if (!/^(select|with|from)\b/i.test(code.trim())) throw new Error('A transform is one SELECT query (it may start with WITH)')
  if (!s.trim()) throw new Error('The SQL is empty')
  return s.trim()
}

/** A cell as a plain value for a bulk load (the same reading as `literal`). */
function plainCell(v: unknown, type: ColumnType): number | boolean | string | null {
  if (v === null || v === undefined || v === '') return null
  switch (type) {
    case 'int':
    case 'double': {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    case 'boolean':
      return v === true || /^(true|1)$/i.test(String(v))
    case 'datetime': {
      const d = new Date(String(v))
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
    default:
      return isGeometryColumn(type) && typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
}

/** Plain columns for a bulk load: vectors travel as two numbers (u, v). */
function stage(columns: ColumnInfo[], rows: DataRecord[]): StagedColumn[] {
  return columns.flatMap((c, i): StagedColumn[] => {
    if (c.type === 'vector') {
      const part = (k: 'u' | 'v') => rows.map((r) => {
        const n = Number((r[c.name] as { u?: unknown; v?: unknown } | null)?.[k])
        return r[c.name] && Number.isFinite(n) ? n : null
      })
      return [
        { name: `c${i}_u`, kind: 'double', values: part('u') },
        { name: `c${i}_v`, kind: 'double', values: part('v') },
      ]
    }
    const kind = c.type === 'int' || c.type === 'double' ? 'double' : c.type === 'boolean' ? 'bool' : 'text'
    return [{ name: `c${i}`, kind, values: rows.map((r) => plainCell(r[c.name], c.type)) }]
  })
}

/** Each staged column cast to its final type, under its real name. */
function castFromStage(columns: ColumnInfo[]): string {
  return columns
    .map((c, i) => {
      const s = `"c${i}"`
      const expr =
        c.type === 'int'
          ? `CAST(${s} AS BIGINT)`
          : c.type === 'datetime'
            ? `TRY_CAST(${s} AS TIMESTAMP)`
            : c.type === 'vector'
              ? `CASE WHEN "c${i}_u" IS NULL OR "c${i}_v" IS NULL THEN NULL ELSE {'u': "c${i}_u", 'v': "c${i}_v"} END`
              : s
      return `${expr} AS ${ident(c.name)}`
    })
    .join(', ')
}

/** About how many cells (rows × columns) the engine keeps loaded before dropping the least recently used tables. */
export const CELL_BUDGET = 8_000_000

export function createSqlRunner(engine: () => Promise<SqlEngine>, opts: { cellBudget?: number } = {}) {
  const budget = opts.cellBudget ?? CELL_BUDGET
  /** Engine copies of datasets: one table per dataset (key), whatever aliases queries use. */
  const tables = new Map<string, { table: string; version: string; cells: number; used: number }>()
  let clock = 0
  let made = 0
  let ready: Promise<SqlEngine> | null = null
  // One query at a time: aliases are views that each query points at its own datasets.
  let queue: Promise<unknown> = Promise.resolve()

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

  /** The engine table holding a dataset's rows, loading it (once per version) if needed. */
  async function table(e: SqlEngine, input: SqlInput): Promise<string> {
    const key = input.key ?? input.alias
    const have = tables.get(key)
    if (have && have.version === input.version) {
      have.used = ++clock
      return have.table
    }
    const name = `__ds_${++made}_${key.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`
    const target = have?.table ?? name
    const cols = input.columns
    const rows = await input.rows()
    if (e.insert && cols.length) {
      await e.query('DROP TABLE IF EXISTS "__stage"')
      await e.insert('__stage', stage(cols, rows))
      await e.query(`CREATE OR REPLACE TABLE ${ident(target)} AS SELECT ${castFromStage(cols)} FROM "__stage"`)
      await e.query('DROP TABLE "__stage"')
    } else {
      await e.query(`CREATE OR REPLACE TABLE ${ident(target)} (${cols.map((c) => `${ident(c.name)} ${SQL_TYPE[c.type]}`).join(', ')})`)
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500).map((r) => `(${cols.map((c) => literal(r[c.name], c.type)).join(', ')})`)
        await e.query(`INSERT INTO ${ident(target)} VALUES ${batch.join(', ')}`)
      }
    }
    tables.set(key, { table: target, version: input.version, cells: rows.length * Math.max(1, cols.length), used: ++clock })
    return target
  }

  /** Drops the least recently used tables while over budget (never the ones this query uses). */
  async function evict(e: SqlEngine, keep: Set<string>) {
    let total = [...tables.values()].reduce((a, t) => a + t.cells, 0)
    const byAge = [...tables.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].used - b[1].used)
    for (const [k, t] of byAge) {
      if (total <= budget) break
      await e.query(`DROP TABLE IF EXISTS ${ident(t.table)}`)
      tables.delete(k)
      total -= t.cells
    }
  }

  /** Runs a SELECT over the inputs. `limit` (and `offset`) page the rows returned (previews); the full count comes back too. */
  function run(sql: string, inputs: SqlInput[], limit?: number, offset = 0): Promise<{ columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number }> {
    const job = queue.then(() => runNow(sql, inputs, limit, offset))
    queue = job.catch(() => undefined)
    return job
  }

  async function runNow(sql: string, inputs: SqlInput[], limit?: number, offset = 0): Promise<{ columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number }> {
    const query = checkSelect(sql)
    const aliases = inputs.map((i) => i.alias)
    const dup = aliases.find((a, i) => aliases.indexOf(a) !== i)
    if (dup) throw new Error(`Two inputs are both called "${dup}"`)
    for (const a of aliases) if (!ALIAS.test(a)) throw new Error(`"${a}" can't be a table name: use letters, digits and _ (not starting with a digit)`)
    const e = await connect()
    for (const input of inputs) {
      const t = await table(e, input)
      // The alias the SQL uses is a view of the dataset's table: free to make, nothing copied.
      await e.query(`CREATE OR REPLACE TEMP VIEW ${ident(input.alias)} AS SELECT * FROM ${ident(t)}`)
    }
    await evict(e, new Set(inputs.map((i) => i.key ?? i.alias)))
    let res: SqlResult
    const paged = limit !== undefined
    try {
      // One run: the page, plus the full count alongside every row.
      res = await e.query(
        paged ? `SELECT *, count(*) OVER () AS "__total" FROM (${query}\n) LIMIT ${Math.max(0, Math.floor(limit))}${offset > 0 ? ` OFFSET ${Math.floor(offset)}` : ''}` : query,
      )
    } catch (err) {
      // An unknown table is almost always a name that isn't one of the inputs' table names: list them.
      const missing = /Table with name (\S+) does not exist/.exec((err as Error).message)
      if (missing) {
        const have = inputs.map((i) => (i.label ? `${i.alias} (${i.label})` : i.alias)).join(', ')
        throw new Error(`No table ${missing[1]}. Tables you can use: ${have}.`)
      }
      throw err
    }
    const fields = paged ? res.fields.filter((f) => f.name !== '__total') : res.fields
    const rows = res.rows.map((r) => Object.fromEntries(fields.map((f) => [f.name, plain(r[f.name], f.type)])))
    let rowCount = rows.length
    if (paged) {
      if (res.rows.length) rowCount = Number(res.rows[0].__total)
      else rowCount = offset > 0 ? Number((await e.query(`SELECT count(*) AS n FROM (${query}\n)`)).rows[0].n) : 0
    }
    // Our types from the values (GeoJSON text → geometry, {u, v} → vector, ISO text → datetime);
    // columns with no values fall back to the engine's type.
    const inferred = new Map(inferColumns(rows).map((c) => [c.name, c.type]))
    const columns = fields.map((f) => ({ name: f.name, type: rows.some((r) => r[f.name] !== null) ? (inferred.get(f.name) ?? 'string') : fromEngineType(f.type) }))
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

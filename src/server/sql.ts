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
// Extensions (shared/sqlExtensions.ts): when a query fails because a function
// or type lives in an allowed extension (spatial), the engine loads it and runs
// the query again. Each result says which loaded extensions the SQL uses, so a
// transform can record what it needs. With spatial loaded, GEOMETRY results
// come back as GeoJSON text (and so as our geometry columns).
//
// The engine is anything that runs SQL and returns rows — DuckDB-WASM in the
// browser (duckdb.ts), its Node build in tests.

import type { DataRecord } from '../lib/data/connectors'
import { inferColumns, isGeometryColumn, type ColumnInfo, type ColumnType } from '../lib/dataset/columns'
import { SQL_EXTENSIONS, conflictOf, sqlExtension } from '../shared/sqlExtensions'

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
  /** Loads an extension (from the app's own copy, else DuckDB's repository); resolves with where from. Engines without it can't load any. */
  loadExtension?(name: string): Promise<string>
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
  // Extensions load only through the allowlist (loadExtension), never on DuckDB's own initiative.
  'SET autoload_known_extensions = false',
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

/** The SQL with strings and comments blanked out (positions kept), to look at the code alone: they may hold anything (a ";", a "don't"). */
const codeOnly = (sql: string) => sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? `'${' '.repeat(m.length - 2)}'` : ' '.repeat(m.length)))

/** The extension a DuckDB error says the query needs ("… but it exists in the spatial extension"). */
export const missingExtension = (message: string): string | undefined => /exists in the (\w+) extension/.exec(message)?.[1]

/**
 * The query with its GEOMETRY columns (from DESCRIBE) turned into GeoJSON
 * text, which our column inference reads as geometry; unchanged without any.
 */
export function geometryAsGeoJson(query: string, described: { column_name: string; column_type: string }[]): string {
  const geo = described.filter((d) => /^GEOMETRY\b/i.test(d.column_type)).map((d) => d.column_name)
  if (!geo.length) return query
  return `SELECT * REPLACE (${geo.map((c) => `CAST(ST_AsGeoJSON(${ident(c)}) AS VARCHAR) AS ${ident(c)}`).join(', ')}) FROM (${query}\n)`
}

/** DuckDB's message without repeats (the browser build prints its "LINE 1: …" excerpt twice). */
export function cleanError(message: string): string {
  const parts = message.split('\n\n')
  return parts.filter((p, i) => parts.indexOf(p) === i).join('\n\n').trim()
}

/**
 * The error as it reads against the user's own SQL. A query we wrapped (paging, GeoJSON output)
 * fails with an excerpt of our wrapper; planning the bare query (EXPLAIN, nothing runs) gives the
 * same parser or binder error at the user's own text. Errors that only happen while running keep
 * the original message.
 */
async function ownError(e: SqlEngine, query: string, wrapped: boolean, message: string): Promise<string> {
  if (wrapped && /\bLINE \d+:/.test(message)) {
    try {
      await e.query(`EXPLAIN ${query}`)
    } catch (err) {
      // Drop the "EXPLAIN " we added from the excerpt, and move its ^ marker back to match.
      return cleanError((err as Error).message).replace(/(LINE 1: )EXPLAIN (.*)\n( *)\^/, (_, a: string, b: string, pad: string) => `${a}${b}\n${pad.slice(8)}^`)
    }
  }
  return cleanError(message)
}

/** One SELECT (or WITH … SELECT) statement, trailing semicolon trimmed; anything else is rejected with a reason. */
export function checkSelect(sql: string): string {
  let s = sql.trim()
  if (!s) throw new Error('The SQL is empty')
  const code = codeOnly(s)
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

  /** Extensions loaded in the engine, each with the (lowercase) function names it added. */
  const loaded = new Map<string, Set<string>>()
  /** Where each loaded extension came from (for the debug log). */
  const sources = new Map<string, string>()

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

  /** Every function name the engine knows, lowercase. */
  async function catalog(e: SqlEngine): Promise<Set<string>> {
    const r = await e.query('SELECT DISTINCT lower(function_name) AS n FROM duckdb_functions()')
    return new Set(r.rows.map((x) => String(x.n)))
  }

  /** Loads an allowed extension once (noting what it adds); the error says why not otherwise. */
  async function ensure(e: SqlEngine, name: string) {
    if (loaded.has(name)) return
    if (!sqlExtension(name)) throw new Error(`This needs DuckDB's ${name} extension, which PowerGIS doesn't load. Extensions it loads: ${SQL_EXTENSIONS.map((x) => x.name).join(', ')}.`)
    const clash = conflictOf(name, loaded.keys())
    if (clash) throw new Error(`The ${name} extension can't load alongside ${clash} in one SQL engine.`)
    if (!e.loadExtension) throw new Error(`Extensions (${name}) can't be loaded here.`)
    const before = await catalog(e)
    try {
      sources.set(name, await e.loadExtension(name))
    } catch (err) {
      throw new Error(`Couldn't load the ${name} extension: ${(err as Error).message}`)
    }
    loaded.set(name, new Set([...(await catalog(e))].filter((n) => !before.has(n))))
  }

  /**
   * The loaded extensions whose functions the SQL calls. Calls only (`name(`): a type name like
   * GEOMETRY is also a common column name.
   */
  function uses(sql: string): string[] {
    const words = new Set([...codeOnly(sql).toLowerCase().matchAll(/([a-z_][a-z0-9_]*)\s*\(/g)].map((m) => m[1]))
    return [...loaded].filter(([, names]) => [...names].some((n) => words.has(n))).map(([name]) => name)
  }

  /** Loads extensions ahead of need (a workspace's transforms use them). Queued like queries. */
  function load(names: string[]): Promise<{ name: string; from: string }[]> {
    const job = queue.then(async () => {
      const e = await connect()
      for (const n of names) await ensure(e, n)
      return [...loaded.keys()].map((name) => ({ name, from: sources.get(name) ?? '' }))
    })
    queue = job.catch(() => undefined)
    return job
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
  function run(sql: string, inputs: SqlInput[], limit?: number, offset = 0): Promise<SqlRun> {
    const job = queue.then(() => runNow(sql, inputs, limit, offset))
    queue = job.catch(() => undefined)
    return job
  }

  async function runNow(sql: string, inputs: SqlInput[], limit?: number, offset = 0): Promise<SqlRun> {
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
    let final = query
    const paged = limit !== undefined
    // A query that names something from an allowed extension loads it and runs again.
    for (let attempt = 0; ; attempt++) {
      try {
        final = loaded.has('spatial') ? geometryAsGeoJson(query, (await e.query(`DESCRIBE SELECT * FROM (${query}\n)`)).rows as never) : query
        // One run: the page, plus the full count alongside every row.
        res = await e.query(
          paged ? `SELECT *, count(*) OVER () AS "__total" FROM (${final}\n) LIMIT ${Math.max(0, Math.floor(limit))}${offset > 0 ? ` OFFSET ${Math.floor(offset)}` : ''}` : final,
        )
        break
      } catch (err) {
        const message = await ownError(e, query, paged || loaded.has('spatial'), (err as Error).message)
        const ext = missingExtension(message)
        if (ext && !loaded.has(ext) && attempt < 3) {
          await ensure(e, ext)
          continue
        }
        // An unknown table is almost always a name that isn't one of the inputs' table names: list them.
        const missing = /Table with name (\S+) does not exist/.exec(message)
        if (missing) {
          const have = inputs.map((i) => (i.label ? `${i.alias} (${i.label})` : i.alias)).join(', ')
          throw new Error(`No table ${missing[1]}. Tables you can use: ${have}.`)
        }
        throw new Error(message)
      }
    }
    const fields = paged ? res.fields.filter((f) => f.name !== '__total') : res.fields
    const rows = res.rows.map((r) => Object.fromEntries(fields.map((f) => [f.name, plain(r[f.name], f.type)])))
    let rowCount = rows.length
    if (paged) {
      if (res.rows.length) rowCount = Number(res.rows[0].__total)
      else rowCount = offset > 0 ? Number((await e.query(`SELECT count(*) AS n FROM (${final}\n)`)).rows[0].n) : 0
    }
    // Our types from the values (GeoJSON text → geometry, {u, v} → vector, ISO text → datetime);
    // columns with no values fall back to the engine's type.
    const inferred = new Map(inferColumns(rows).map((c) => [c.name, c.type]))
    const columns = fields.map((f) => ({ name: f.name, type: rows.some((r) => r[f.name] !== null) ? (inferred.get(f.name) ?? 'string') : fromEngineType(f.type) }))
    return { columns, rows, rowCount, extensions: uses(query) }
  }

  return { run, load }
}

export interface SqlRun {
  columns: ColumnInfo[]
  rows: DataRecord[]
  rowCount: number
  /** The loaded extensions this SQL uses (what a transform records as its needs). */
  extensions: string[]
}

function fromEngineType(t: string): ColumnType {
  if (/^(Int|Uint)/.test(t)) return 'int'
  if (/^(Float|Decimal)/.test(t)) return 'double'
  if (/^Bool/.test(t)) return 'boolean'
  if (/^(Timestamp|Date)/.test(t)) return 'datetime'
  if (/^Struct<\{u:.*v:/.test(t)) return 'vector'
  return 'string'
}

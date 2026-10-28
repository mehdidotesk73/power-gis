// The SQL engine in the browser: DuckDB-WASM, loaded on first use (the
// .wasm is ~34 MB, so nothing downloads until a transform runs). Only the
// exception-handling build ships; every browser this app targets (iOS
// Safari 15.2+) supports it. DuckDB runs in its own worker, started from
// this server worker.
//
// Extensions (shared/sqlExtensions.ts) load from the app's own copy when the
// build hosted one (`<base>duckdb-ext/`, scripts/fetch-duckdb-extensions.mjs),
// else from DuckDB's repository.
import { AsyncDuckDB, VoidLogger } from '@duckdb/duckdb-wasm'
import wasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import { extensionPath, sqlExtension } from '../shared/sqlExtensions'
import { stagedIPC } from './arrowStage'
import type { SqlEngine } from './sql'

const DUCKDB_REPOSITORY = 'https://extensions.duckdb.org'

/** Whether the app serves its own copy of an extension (a missing file comes back as the app's HTML page). */
async function hosted(repo: string, name: string): Promise<boolean> {
  try {
    const r = await fetch(`${repo}/${extensionPath(name)}`, { method: 'HEAD' })
    return r.ok && !/html/i.test(r.headers.get('content-type') ?? '')
  } catch {
    return false
  }
}

export async function openDuckDb(opts: { extensionRepository?: string } = {}): Promise<SqlEngine> {
  const db = new AsyncDuckDB(new VoidLogger(), new Worker(workerUrl))
  await db.instantiate(wasmUrl)
  const conn = await db.connect()
  return {
    async query(sql) {
      const t = await conn.query(sql)
      return {
        fields: t.schema.fields.map((f) => ({ name: f.name, type: String(f.type) })),
        rows: t.toArray().map((r) => r.toJSON() as Record<string, unknown>),
      }
    },
    async insert(table, columns) {
      await conn.insertArrowFromIPCStream(stagedIPC(columns), { name: table, create: true })
    },
    async loadExtension(name) {
      const own = opts.extensionRepository
      const repos = own && sqlExtension(name)?.hosted && (await hosted(own, name)) ? [own, DUCKDB_REPOSITORY] : [DUCKDB_REPOSITORY]
      let last: unknown
      for (const repo of repos) {
        try {
          await conn.query(`SET custom_extension_repository = '${repo.replace(/'/g, "''")}'`)
          // In the browser LOAD fetches the file itself; INSTALL is tried for builds that want it first.
          await conn.query(`INSTALL ${name}`).catch(() => undefined)
          await conn.query(`LOAD ${name}`)
          return repo === own ? 'this app' : repo
        } catch (e) {
          last = e
        }
      }
      throw last
    },
  }
}

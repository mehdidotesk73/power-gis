// The SQL engine in the browser: DuckDB-WASM, loaded on first use (the
// .wasm is ~34 MB, so nothing downloads until a transform runs). Only the
// exception-handling build ships; every browser this app targets (iOS
// Safari 15.2+) supports it. DuckDB runs in its own worker, started from
// this server worker.
import { AsyncDuckDB, VoidLogger } from '@duckdb/duckdb-wasm'
import wasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import { stagedIPC } from './arrowStage'
import type { SqlEngine } from './sql'

export async function openDuckDb(): Promise<SqlEngine> {
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
  }
}

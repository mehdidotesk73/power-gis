// Tests only: real DuckDB through its Node build (synchronous), behind the
// same SqlEngine interface the browser uses. Never imported by app code.
import { createRequire } from 'node:module'
import type { SqlEngine } from './sql'

export async function nodeDuckDb(): Promise<SqlEngine> {
  const require = createRequire(import.meta.url)
  const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs')
  const wasm = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm')
  const db = await duckdb.createDuckDB({ mvp: { mainModule: wasm, mainWorker: '' }, eh: { mainModule: wasm, mainWorker: '' } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME)
  await db.instantiate()
  const conn = db.connect()
  return {
    async query(sql) {
      const t = conn.query(sql)
      return {
        fields: t.schema.fields.map((f: { name: string; type: unknown }) => ({ name: f.name, type: String(f.type) })),
        rows: t.toArray().map((r: { toJSON(): Record<string, unknown> }) => r.toJSON()),
      }
    },
  }
}

// The server's process today: a Web Worker. It owns writes to the device
// database and does the heavy work, answering the page's requests by id.
import countiesUrl from 'us-atlas/counties-10m.json?url'
import statesUrl from 'us-atlas/states-10m.json?url'
import { createServer } from './server'
import { IndexedDbDatabase } from '../shared/idb'
import { StaticFileConnector } from '../lib/data/connectors'
import { countyRows, stateRows } from '../lib/data/boundaryTables'
import { demoVectorRows } from '../lib/demo'
import { BUILTIN_TABLES } from '../shared/builtins'
import type { RequestMessage, ResponseMessage } from '../shared/api'

async function topo(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return r.json()
}

const server = createServer(new IndexedDbDatabase(), {
  // DuckDB (and its ~34 MB of wasm) loads only when a transform first runs.
  sql: () => import('./duckdb').then((m) => m.openDuckDb()),
  async readBuiltin(table, baseUrl) {
    if (table === 'demo_vectors') return demoVectorRows()
    if (table === 'us_counties') return countyRows(await topo(countiesUrl))
    if (table === 'us_states') return stateRows(await topo(statesUrl))
    const csvs = BUILTIN_TABLES.filter((t) => t.source === 'csv').map((t) => t.table)
    return new StaticFileConnector(csvs, baseUrl).readTable(table)
  },
})

self.onmessage = async (e: MessageEvent<RequestMessage>) => {
  const { id, type, payload, caller } = e.data
  const result = await server.handle(type, payload as never, caller)
  self.postMessage({ id, result } satisfies ResponseMessage)
}

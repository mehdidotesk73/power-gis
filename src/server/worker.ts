// The server's process today: a Web Worker. It owns writes to the device
// database and does the heavy work, answering the page's requests by id.
import { createServer } from './server'
import { IndexedDbDatabase } from '../shared/idb'
import { loadBoundaries } from '../lib/dataset/boundaries'
import { StaticFileConnector } from '../lib/data/connectors'
import { demoVectorRows } from '../lib/demo'
import { withOwnershipFlags } from '../lib/utilities'
import { UTILITY_TABLE } from '../shared/builtins'
import type { RequestMessage, ResponseMessage } from '../shared/api'

const server = createServer(new IndexedDbDatabase(), {
  loadBoundaries,
  async readBuiltin(table, baseUrl) {
    if (table === 'demo_vectors') return demoVectorRows()
    const rows = await new StaticFileConnector([UTILITY_TABLE, 'utilities'], baseUrl).readTable(table)
    return table === UTILITY_TABLE ? withOwnershipFlags(rows) : rows
  },
})

self.onmessage = async (e: MessageEvent<RequestMessage>) => {
  const { id, type, payload } = e.data
  const result = await server.handle(type, payload as never)
  self.postMessage({ id, result } satisfies ResponseMessage)
}

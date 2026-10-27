// The client's only way to change anything lasting or ask for heavy work:
// requests to the server (a Web Worker today, HTTP later). Every call
// resolves to an ApiResult — check `ok`, never catch.
import { isProxy, toRaw } from 'vue'
import type { ApiResult, Caller, Payload, RequestMessage, RequestType, Response, ResponseMessage } from '../shared/api'

/** Plain data for the wire: Vue's reactive proxies can't be cloned (Files and Blobs pass through). */
function plain<T>(v: T): T {
  const raw = isProxy(v) ? toRaw(v) : v
  if (raw === null || typeof raw !== 'object' || raw instanceof Blob) return raw
  if (Array.isArray(raw)) return raw.map(plain) as T
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(raw)) out[k] = plain(x)
  return out as T
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, (r: ApiResult<unknown>) => void>()

function connect(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../server/worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<ResponseMessage>) => {
    pending.get(e.data.id)?.(e.data.result)
    pending.delete(e.data.id)
  }
  worker.onerror = (e) => {
    // A crashed server fails every request still waiting.
    for (const resolve of pending.values()) resolve({ ok: false, error: { code: 'failed', message: `server: ${e.message || 'worker error'}` } })
    pending.clear()
    worker = null
  }
  return worker
}

/** `caller: 'agent'` marks an agent's request: the server refuses its changes to remote datasets. */
export function request<K extends RequestType>(type: K, payload: Payload<K>, caller: Caller = 'user'): Promise<ApiResult<Response<K>>> {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve as (r: ApiResult<unknown>) => void)
    connect().postMessage({ id, type, payload: plain(payload), ...(caller === 'agent' ? { caller } : {}) } satisfies RequestMessage<K>)
  })
}

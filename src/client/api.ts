// The client's only way to change anything lasting or ask for heavy work:
// requests to the server (a Web Worker today, HTTP later). Every call
// resolves to an ApiResult — check `ok`, never catch.
import { isProxy, toRaw } from 'vue'
import type { ApiResult, Caller, Payload, RequestMessage, RequestType, Response, ResponseMessage } from '../shared/api'
import { logDebug } from '../debug'

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
/** The page's session requests (init, then the signed-in user's token), sent again first to a server that restarted. */
const replay = new Map<'init' | 'setAuth', unknown>()

function connect(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../server/worker.ts', import.meta.url), { type: 'module' })
  for (const [type, payload] of replay) {
    const id = nextId++
    pending.set(id, (r) => !r.ok && logDebug(`server restart: ${type} failed — ${r.error.message}`, 'warn'))
    worker.postMessage({ id, type, payload } as RequestMessage)
  }
  worker.onmessage = (e: MessageEvent<ResponseMessage>) => {
    pending.get(e.data.id)?.(e.data.result)
    pending.delete(e.data.id)
  }
  worker.onerror = (e) => {
    // A crashed server fails every request still waiting.
    for (const resolve of pending.values()) resolve({ ok: false, error: { code: 'failed', message: `server: ${e.message || 'worker error'}` } })
    pending.clear()
    worker = null
    logDebug(`server stopped (${e.message || 'worker error'}); it restarts on the next request`, 'warn')
  }
  return worker
}

/** Requests that may reach the cloud: each first hands the server the session's current sign-in (`beforeCloud`). */
const CLOUD_REQUESTS = new Set<RequestType>(['cloudWorkspaces', 'cloudWorkspace', 'saveCloudWorkspace', 'deleteCloudWorkspace', 'openDocument', 'linkToCloud', 'pushDataset', 'pullDataset', 'deleteFromCloud', 'cloudStatus', 'cloudDatasets', 'addFromCloud', 'datasetMembers', 'shareDataset', 'setMemberAccess', 'removeMember'])
let beforeCloud: (() => Promise<unknown>) | null = null
/**
 * Set by the account code: sends the server the current token. Run before every cloud request,
 * since the server's copy of it can go stale or missing (a token refreshed while the phone slept,
 * a restarted worker) and a stale one reads as signed out.
 */
export function onBeforeCloud(fn: () => Promise<unknown>) {
  beforeCloud = fn
}

/** `caller: 'agent'` marks an agent's request: the server refuses its changes to remote datasets. */
export async function request<K extends RequestType>(type: K, payload: Payload<K>, caller: Caller = 'user'): Promise<ApiResult<Response<K>>> {
  if (CLOUD_REQUESTS.has(type) && beforeCloud) await beforeCloud().catch(() => undefined)
  return send(type, payload, caller)
}

function send<K extends RequestType>(type: K, payload: Payload<K>, caller: Caller = 'user'): Promise<ApiResult<Response<K>>> {
  if (type === 'init' || type === 'setAuth') replay.set(type, plain(payload))
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve as (r: ApiResult<unknown>) => void)
    connect().postMessage({ id, type, payload: plain(payload), ...(caller === 'agent' ? { caller } : {}) } satisfies RequestMessage<K>)
  })
}

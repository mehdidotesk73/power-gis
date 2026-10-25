// Browser storage for the workspace: localStorage for the document,
// IndexedDB for imported tables (too big for localStorage's ~5 MB). Either
// can be unavailable (private mode, blocked site data), so every call is
// allowed to fail and callers carry on without saving.
import type { DataRecord } from '../../lib/data/connectors'
import type { KeyValueStore, TableStore } from '../../lib/workspace/storage'

export const localKeyValueStore: KeyValueStore = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
}

const DB = 'powergis'
const STORE = 'tables'

let dbPromise: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
  }).catch((e) => {
    dbPromise = null
    throw e
  })
  return dbPromise
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db()
  return new Promise<T>((resolve, reject) => {
    const tx = d.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result as T)
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error ?? new Error('IndexedDB request failed'))
  })
}

export const indexedDbTableStore: TableStore = {
  put: (id, rows) => run<void>('readwrite', (s) => s.put(rows, id)),
  get: (id) => run<DataRecord[] | undefined>('readonly', (s) => s.get(id)),
  delete: (id) => run<void>('readwrite', (s) => s.delete(id)),
  clear: () => run<void>('readwrite', (s) => s.clear()),
}

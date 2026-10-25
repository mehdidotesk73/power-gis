// The database on this device: IndexedDB, one object store per base table
// plus `data` for the data tables (keyed by table name). The server worker
// opens it read-write; the page opens the same database through
// `ReadDatabase` only. IndexedDB can be unavailable (private mode, blocked
// site data) — callers get the rejection.

import type { DataRecord } from '../lib/data/connectors'
import type { Database } from './database'
import { TABLES, type TableName, type Tables } from './records'

const NAME = 'powergis-db'
const DATA = 'data'

export class IndexedDbDatabase implements Database {
  private db: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(NAME, 1)
      req.onupgradeneeded = () => {
        for (const t of [...TABLES, DATA]) if (!req.result.objectStoreNames.contains(t)) req.result.createObjectStore(t)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
    }).catch((e) => {
      this.db = null
      throw e
    })
    return this.db
  }

  private async run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.open()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode)
      const req = fn(tx.objectStore(store))
      tx.oncomplete = () => resolve(req.result as T)
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error ?? new Error('IndexedDB request failed'))
    })
  }

  get<T extends TableName>(table: T, id: string) {
    return this.run<Tables[T] | undefined>(table, 'readonly', (s) => s.get(id))
  }
  list<T extends TableName>(table: T) {
    return this.run<Tables[T][]>(table, 'readonly', (s) => s.getAll())
  }
  put<T extends TableName>(table: T, record: Tables[T]) {
    return this.run<void>(table, 'readwrite', (s) => s.put(record, record.id))
  }
  delete<T extends TableName>(table: T, id: string) {
    return this.run<void>(table, 'readwrite', (s) => s.delete(id))
  }
  readRows(table: string) {
    return this.run<DataRecord[] | undefined>(DATA, 'readonly', (s) => s.get(table))
  }
  writeRows(table: string, rows: DataRecord[]) {
    return this.run<void>(DATA, 'readwrite', (s) => s.put(rows, table))
  }
  dropRows(table: string) {
    return this.run<void>(DATA, 'readwrite', (s) => s.delete(table))
  }
}

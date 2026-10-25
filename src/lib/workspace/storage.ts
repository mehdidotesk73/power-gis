// Saving the workspace on the device: the document in a key-value store,
// imported tables' rows in a table store. Interfaces here; the browser
// implementations (localStorage, IndexedDB) live in components/workspace,
// and in-memory ones below serve tests.

import type { DataRecord } from '../data/connectors'
import { parseWorkspace, serializeWorkspace, type WorkspaceDoc } from './workspace'

export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export interface TableStore {
  put(id: string, rows: DataRecord[]): Promise<void>
  get(id: string): Promise<DataRecord[] | undefined>
  delete(id: string): Promise<void>
  clear(): Promise<void>
}

export const WORKSPACE_KEY = 'powergis.workspace.v1'

/** The saved workspace, or null if there's none (or it can't be read). */
export function loadWorkspace(kv: KeyValueStore): WorkspaceDoc | null {
  let text: string | null = null
  try {
    text = kv.get(WORKSPACE_KEY)
  } catch {
    return null
  }
  if (!text) return null
  const r = parseWorkspace(text)
  return r.ok ? r.doc : null
}

/** Returns false when the store refused (private mode, quota). */
export function saveWorkspace(kv: KeyValueStore, doc: WorkspaceDoc): boolean {
  try {
    kv.set(WORKSPACE_KEY, serializeWorkspace(doc))
    return true
  } catch {
    return false
  }
}

export class MemoryKeyValueStore implements KeyValueStore {
  private m = new Map<string, string>()
  get(key: string) {
    return this.m.get(key) ?? null
  }
  set(key: string, value: string) {
    this.m.set(key, value)
  }
  remove(key: string) {
    this.m.delete(key)
  }
}

export class MemoryTableStore implements TableStore {
  private m = new Map<string, DataRecord[]>()
  async put(id: string, rows: DataRecord[]) {
    this.m.set(id, structuredClone(rows))
  }
  async get(id: string) {
    const r = this.m.get(id)
    return r ? structuredClone(r) : undefined
  }
  async delete(id: string) {
    this.m.delete(id)
  }
  async clear() {
    this.m.clear()
  }
}

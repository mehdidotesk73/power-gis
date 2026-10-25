// Database access. The client gets only `ReadDatabase` (later: a Supabase
// client reading tables); the server gets the full `Database`. Data tables
// (one per dataset) are addressed by name.

import type { DataRecord } from '../lib/data/connectors'
import type { TableName, Tables } from './records'

export interface ReadDatabase {
  get<T extends TableName>(table: T, id: string): Promise<Tables[T] | undefined>
  list<T extends TableName>(table: T): Promise<Tables[T][]>
  /** A data table's rows, or undefined if there's no such table. */
  readRows(table: string): Promise<DataRecord[] | undefined>
}

export interface Database extends ReadDatabase {
  put<T extends TableName>(table: T, record: Tables[T]): Promise<void>
  delete<T extends TableName>(table: T, id: string): Promise<void>
  writeRows(table: string, rows: DataRecord[]): Promise<void>
  dropRows(table: string): Promise<void>
}

/** In memory, for tests. Stores copies, like a real database. */
export class MemoryDatabase implements Database {
  private tables = new Map<string, Map<string, unknown>>()
  private data = new Map<string, DataRecord[]>()
  private t(name: string) {
    let m = this.tables.get(name)
    if (!m) this.tables.set(name, (m = new Map()))
    return m
  }
  async get<T extends TableName>(table: T, id: string) {
    const r = this.t(table).get(id)
    return r === undefined ? undefined : (structuredClone(r) as Tables[T])
  }
  async list<T extends TableName>(table: T) {
    return [...this.t(table).values()].map((r) => structuredClone(r) as Tables[T])
  }
  async put<T extends TableName>(table: T, record: Tables[T]) {
    this.t(table).set(record.id, structuredClone(record))
  }
  async delete<T extends TableName>(table: T, id: string) {
    this.t(table).delete(id)
  }
  async readRows(table: string) {
    const r = this.data.get(table)
    return r && structuredClone(r)
  }
  async writeRows(table: string, rows: DataRecord[]) {
    this.data.set(table, structuredClone(rows))
  }
  async dropRows(table: string) {
    this.data.delete(table)
  }
}

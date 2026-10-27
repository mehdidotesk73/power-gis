// Rows as Arrow columns for DuckDB's bulk insert (an Arrow IPC stream): far
// faster than SQL text for wide tables (a 3,071 × 330 table took ~11 s as
// INSERT … VALUES). Columns arrive already plain (numbers, booleans, text, or
// null); sql.ts casts them to their final types in one SELECT. Used by both
// engines (browser and tests). We hand DuckDB serialized bytes, not an Arrow
// Table object: insertArrowTable quietly created nothing when the Table came
// from a different copy of apache-arrow than DuckDB's own (the Node build).
import { Bool, Float64, Table, Utf8, tableToIPC, vectorFromArray } from 'apache-arrow'
import type { StagedColumn } from './sql'

/** The columns as an Arrow IPC stream (for insertArrowFromIPCStream). */
export const stagedIPC = (columns: StagedColumn[]): Uint8Array => tableToIPC(stagedTable(columns), 'stream')

export function stagedTable(columns: StagedColumn[]): Table {
  const vectors = Object.fromEntries(
    columns.map((c) => {
      const type = c.kind === 'double' ? new Float64() : c.kind === 'bool' ? new Bool() : new Utf8()
      return [c.name, vectorFromArray(c.values as never[], type)]
    }),
  )
  return new Table(vectors)
}

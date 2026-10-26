// A dataset's profile: what's in each column — how full it is, how many
// distinct values, the range. Computed by the server whenever a data table
// is written, and stored on the dataset record (agents report it for
// approval; the dataset panel shows it).

import type { DataRecord } from '../data/connectors'
import { coerce, isGeometryColumn, isNumericColumn, type ColumnInfo, type ColumnType } from './columns'

export interface ColumnProfile {
  name: string
  type: ColumnType
  /** Rows with a value (after coercion to the column's type). */
  filled: number
  distinct: number
  /** Numbers and datetimes only. */
  min?: number | string
  max?: number | string
}

export interface DatasetProfile {
  rowCount: number
  columns: ColumnProfile[]
  /** Share of all cells that have a value, 0–1. */
  completeness: number
}

const DISTINCT_CAP = 100_000

export function profileRows(rows: DataRecord[], columns: ColumnInfo[]): DatasetProfile {
  let filledCells = 0
  const profiles = columns.map((c): ColumnProfile => {
    const seen = new Set<string>()
    let filled = 0
    let min: number | string | undefined
    let max: number | string | undefined
    const ordered = isNumericColumn(c.type) || c.type === 'datetime'
    for (const r of rows) {
      const v = coerce(r[c.name], c.type)
      if (v === null || v === undefined) continue
      filled++
      if (seen.size < DISTINCT_CAP) seen.add(isGeometryColumn(c.type) || typeof v === 'object' ? JSON.stringify(v) : String(v))
      if (ordered) {
        const x = v as number | string
        if (min === undefined || x < min) min = x
        if (max === undefined || x > max) max = x
      }
    }
    filledCells += filled
    return { name: c.name, type: c.type, filled, distinct: seen.size, ...(min !== undefined ? { min, max } : {}) }
  })
  const cells = rows.length * columns.length
  return { rowCount: rows.length, columns: profiles, completeness: cells ? filledCells / cells : 1 }
}

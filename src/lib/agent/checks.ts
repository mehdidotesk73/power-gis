// What run_transform tells the agent about each output it wrote: the facts
// for "Checking each stage" (prompt), computed by the app from the dataset's
// profile instead of left to the agent's queries — row counts against the
// inputs', which columns are unique (a key), nulls, ranges — plus mechanical
// flags. The agent still decides what they mean.

import type { DatasetRecord } from '../../shared/records'
import { isGeometryColumn } from '../dataset/columns'

export interface ColumnCheck {
  name: string
  type: string
  /** Unknown when the dataset has no profile for it. */
  nulls?: number
  distinct?: number
  min?: number | string
  max?: number | string
}

export interface OutputCheck {
  rows: number
  /** Each input's row count, by alias. */
  inputs: { alias: string; rows: number }[]
  /** Columns with a different value on every row (keys), geometry aside. */
  unique: string[]
  columns: ColumnCheck[]
  /** Things worth a look, worded for the agent. */
  flags: string[]
}

/** More columns than this are summarized by name only. */
const MAX_COLUMNS = 40
const round = (v: number | string | undefined) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v)

export function outputCheck(out: DatasetRecord, inputs: { alias: string; record?: DatasetRecord }[]): OutputCheck {
  const rows = out.rowCount
  const ins = inputs.flatMap((i) => (i.record ? [{ alias: i.alias, rows: i.record.rowCount }] : []))
  const profile = out.profile
  const flags: string[] = []
  const columns: ColumnCheck[] = []
  const unique: string[] = []
  for (const c of out.columns) {
    const p = profile?.columns.find((x) => x.name === c.name)
    if (!p) {
      columns.push({ name: c.name, type: c.type })
      continue
    }
    const nulls = rows - p.filled
    if (isGeometryColumn(c.type)) columns.push({ name: c.name, type: c.type, nulls })
    else {
      columns.push({ name: c.name, type: c.type, nulls, distinct: p.distinct, ...(p.min !== undefined ? { min: round(p.min), max: round(p.max) } : {}) })
      if (rows > 1 && p.filled === rows && p.distinct === rows) unique.push(c.name)
    }
    if (rows && p.filled === 0) flags.push(`"${c.name}" is empty on every row`)
  }
  const largest = Math.max(0, ...ins.map((i) => i.rows))
  if (ins.length && rows > largest) flags.push(`${rows.toLocaleString()} rows, more than any input (${largest.toLocaleString()}): did a join match more than one row per key?`)
  if (rows > 1 && profile && !unique.length) flags.push('no column has a different value on every row: if a row should be one key, some keys repeat')
  if (rows === 0) flags.push('no rows')
  const shown = columns.length > MAX_COLUMNS ? columns.slice(0, MAX_COLUMNS) : columns
  if (shown.length < columns.length) flags.push(`${columns.length} columns; the first ${MAX_COLUMNS} are listed (query the rest)`)
  return { rows, inputs: ins, unique, columns: shown, flags }
}

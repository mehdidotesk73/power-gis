// Helpers every tool uses: input checks, results, small formatters.

import { storeOf, type DatasetRecord } from '../../shared/records'
import type { ColumnInfo } from '../../lib/dataset/columns'
import { isGeometryColumn } from '../../lib/dataset/columns'
import type { PaletteName } from '../../lib/palettes'
import { type WorkspaceDoc } from '../../lib/workspace/workspace'
import { snapshot } from '../../lib/workspace/file'
import type { ToolOutcome } from '../../lib/agent/loop'

export const PALETTES: PaletteName[] = ['auto', 'p12', 'p24', 'p60', 'many']

export const AGG_NAMES = ['first', 'count', 'distinct', 'sum', 'mean', 'min', 'max', 'mode', 'any']

/** A short stamp of the workspace's contents (changes whenever anything does). */
export function workspaceVersion(doc: WorkspaceDoc): string {
  let h = 0x811c9dc5
  const s = snapshot(doc)
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

export type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export const str = (v: unknown): v is string => typeof v === 'string'

export const optStr = (v: unknown) => v === undefined || str(v)

export class Invalid extends Error {}

export function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Invalid(message)
}

export const ok = (data: unknown, summary: string): ToolOutcome => ({ content: JSON.stringify(data), isError: false, summary })

export const err = (message: string, summary = message): ToolOutcome => ({ content: message, isError: true, summary })

export const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

/** The store as users call it: local (this device) or cloud. */
export const storeLabel = (d: DatasetRecord) => (storeOf(d) === 'remote' ? 'cloud' : 'local')

export const columnsOf = (cols: ColumnInfo[]) => cols.map((c) => `${c.name} ${c.type}`).join(', ')

/** A cell as the model sees it: geometry as its type, long text cut. */
export function cell(v: unknown, type: string | undefined): unknown {
  if (v === null || v === undefined) return null
  if (type && isGeometryColumn(type as ColumnInfo['type'])) return `<${type}>`
  if (typeof v === 'string') {
    if (/^\s*\{"type":"(Multi)?(Point|LineString|Polygon)"/.test(v)) return '<geometry>'
    return v.length > 200 ? `${v.slice(0, 200)}…` : v
  }
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 200 ? `${s.slice(0, 200)}…` : v
  }
  return v
}

export const PLACEHOLDER = 'not described yet'

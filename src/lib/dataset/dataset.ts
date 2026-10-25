// Dataset helpers. A dataset is a plain table of rows (stored server side);
// visualizations say how its rows become map features (query.ts).

import type { DataRecord } from '../data/connectors'
import type { FieldType } from '../schema'
import type { ColumnType } from './columns'

// Synthetic properties on every dataset feature.
export const KEY = '_key'
export const LABEL = '_label'
export const ROW_COUNT = '_rows'

/** Every database record (and visualization) is keyed by a uuid. */
export const newId = (): string => crypto.randomUUID()

export function fieldTypeOf(t: ColumnType): FieldType {
  return t === 'geometry' ? 'string' : t
}

/**
 * Add a vector column built from two numeric columns (east, north), for
 * tables that store vectors as separate u/v columns.
 */
export function withVectorColumn(records: DataRecord[], name: string, u: string, v: string): DataRecord[] {
  return records.map((r) => {
    const uu = Number(r[u])
    const vv = Number(r[v])
    const ok = r[u] !== null && r[u] !== '' && r[v] !== null && r[v] !== '' && Number.isFinite(uu) && Number.isFinite(vv)
    return { ...r, [name]: ok ? { u: uu, v: vv } : null }
  })
}

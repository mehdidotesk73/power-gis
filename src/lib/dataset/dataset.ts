// Dataset helpers. A dataset is a plain table of rows (stored server side);
// visualizations say how its rows become map features (query.ts).

import type { DataRecord } from '../data/connectors'
import type { FieldType } from '../schema'
import { isGeometryColumn, type ColumnType } from './columns'

// Synthetic properties on every dataset feature.
export const KEY = '_key'
export const LABEL = '_label'
export const ROW_COUNT = '_rows'

/** Every database record (and visualization) is keyed by a uuid. */
export const newId = (): string => crypto.randomUUID()

export function fieldTypeOf(t: ColumnType): FieldType {
  return isGeometryColumn(t) ? 'string' : t
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

/** Add a point column (GeoJSON Point, lon/lat) from latitude and longitude columns. Invalid pairs give null. */
export function withPointColumn(records: DataRecord[], name: string, lat: string, lon: string): DataRecord[] {
  const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === ''
  return records.map((r) => {
    const y = Number(r[lat])
    const x = Number(r[lon])
    const ok = !blank(r[lat]) && !blank(r[lon]) && Number.isFinite(x) && Number.isFinite(y) && Math.abs(y) <= 90 && Math.abs(x) <= 180
    return { ...r, [name]: ok ? { type: 'Point', coordinates: [x, y] } : null }
  })
}

const LAT_COL = /^(lat|latitude|y|lat_?dd)$/i
const LON_COL = /^(lon|lng|long|longitude|x|lon_?dd)$/i

/** Latitude and longitude columns by name, if a table has an obvious pair. */
export function guessLatLon(columns: { name: string }[]): { lat: string; lon: string } | null {
  const lat = columns.find((c) => LAT_COL.test(c.name))
  const lon = columns.find((c) => LON_COL.test(c.name))
  return lat && lon ? { lat: lat.name, lon: lon.name } : null
}

// Dataset helpers. A dataset is a plain table of rows (stored server side);
// visualizations say how its rows become map features (query.ts).

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

const LAT_COL = /^(lat|latitude|y|lat_?dd)$/i
const LON_COL = /^(lon|lng|long|longitude|x|lon_?dd)$/i

/** Latitude and longitude columns by name, if a table has an obvious pair. */
export function guessLatLon(columns: { name: string }[]): { lat: string; lon: string } | null {
  const lat = columns.find((c) => LAT_COL.test(c.name))
  const lon = columns.find((c) => LON_COL.test(c.name))
  return lat && lon ? { lat: lat.name, lon: lon.name } : null
}

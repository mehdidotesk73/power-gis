// A clearly-synthetic vector field for exercising the arrow widget until a
// real vector dataset (e.g. interchange flows) is loaded. Not power data.

import type { DataRecord } from './data/source'

/** A lat/lon grid over the lower 48 with smooth east/north components. */
export function demoVectorRows(): DataRecord[] {
  const rows: DataRecord[] = []
  for (let lat = 25.5; lat <= 48.5; lat += 1.5) {
    for (let lon = -123.5; lon <= -68; lon += 2) {
      rows.push({
        lat,
        lon,
        u_east: Math.round((Math.sin((lat - 25) / 4) * 10 + 4) * 100) / 100,
        v_north: Math.round(Math.cos((lon + 100) / 6) * 8 * 100) / 100,
      })
    }
  }
  return rows
}

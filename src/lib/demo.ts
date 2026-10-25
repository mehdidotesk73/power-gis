// A clearly-synthetic vector field for exercising the arrow widget until a
// real vector dataset (e.g. interchange flows) is loaded. Not power data.

import { anchorPoint } from './geometry'
import type { LayerData } from './schema'

export function demoVectorLayer(regions: LayerData): LayerData {
  const features = regions.features.flatMap((f) => {
    const p = anchorPoint(f.geometry)
    if (!p) return []
    const [lon, lat] = p
    const u = Math.sin((lat - 25) / 4) * 10 + 4
    const v = Math.cos((lon + 100) / 6) * 8
    return [
      {
        type: 'Feature' as const,
        id: String(f.properties[regions.idField]),
        geometry: { type: 'Point' as const, coordinates: [lon, lat] },
        properties: { id: String(f.properties[regions.idField]), name: String(f.properties[regions.titleField ?? regions.idField]), u_east: u, v_north: v },
      },
    ]
  })
  return {
    id: 'demo-vectors',
    name: 'Demo vector field (synthetic)',
    geometry: 'point',
    idField: 'id',
    titleField: 'name',
    fields: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string', alias: 'Anchor' },
      { name: 'u_east', type: 'double', alias: 'East component' },
      { name: 'v_north', type: 'double', alias: 'North component' },
    ],
    features,
    source: { label: 'Synthetic — for testing the vector widget' },
  }
}

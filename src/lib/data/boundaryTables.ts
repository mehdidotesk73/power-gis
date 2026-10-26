// Built-in boundary datasets: US counties and states as plain tables with a
// region geometry column, from the us-atlas TopoJSON (Census 2017, 1:10m).
// Region codes in other datasets are joined onto them in a transform.

import { feature as topoFeature } from 'topojson-client'
import type { Feature, Geometry } from 'geojson'
import type { DataRecord } from './connectors'
import { STATES } from '../states'

type Topo = { objects: Record<string, unknown> }
type Features = { features: Feature<Geometry, { name?: string }>[] }

const features = (topo: Topo, object: string) => (topoFeature(topo as never, topo.objects[object] as never) as unknown as Features).features

/** One row per county: fips (5 digits), name ("Autauga, AL"), county, state, state_fips, geometry. */
export function countyRows(topo: Topo): DataRecord[] {
  return features(topo, 'counties').map((f) => {
    const fips = String(f.id).padStart(5, '0')
    const st = STATES[fips.slice(0, 2)]
    const county = f.properties?.name ?? fips
    return { fips, name: st ? `${county}, ${st.abbr}` : county, county, state: st?.abbr ?? null, state_fips: fips.slice(0, 2), geometry: f.geometry }
  })
}

/** One row per state / territory: fips (2 digits), name, abbr, geometry. */
export function stateRows(topo: Topo): DataRecord[] {
  return features(topo, 'states').map((f) => {
    const fips = String(f.id).padStart(2, '0')
    const st = STATES[fips]
    return { fips, name: st?.name ?? f.properties?.name ?? fips, abbr: st?.abbr ?? null, geometry: f.geometry }
  })
}

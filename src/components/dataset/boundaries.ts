// Built-in boundary polygons for region-code bindings, fetched on first use
// and cached for the session.

import { feature as topoFeature } from 'topojson-client'
import type { Feature, Geometry } from 'geojson'
import countiesUrl from 'us-atlas/counties-10m.json?url'
import statesUrl from 'us-atlas/states-10m.json?url'
import { boundaryIndex, type BoundaryFeature, type BoundaryId } from '../../lib/dataset/binding'

const SOURCES: Record<BoundaryId, { url: string; object: string }> = {
  'us-counties': { url: countiesUrl, object: 'counties' },
  'us-states': { url: statesUrl, object: 'states' },
}

const cache = new Map<BoundaryId, Promise<Map<string, BoundaryFeature>>>()

export function loadBoundaries(id: BoundaryId): Promise<Map<string, BoundaryFeature>> {
  let p = cache.get(id)
  if (!p) {
    const { url, object } = SOURCES[id]
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`boundaries ${id}: HTTP ${r.status}`)
        return r.json()
      })
      .then((topo) => {
        const fc = topoFeature(topo, topo.objects[object]) as unknown as { features: Feature<Geometry, { name?: string }>[] }
        return boundaryIndex(id, fc.features)
      })
    p.catch(() => cache.delete(id)) // let a later attempt retry
    cache.set(id, p)
  }
  return p
}

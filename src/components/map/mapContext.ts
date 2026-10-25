// Shared plumbing for map widgets: MapView provides the map; layer widgets
// inject it, add their sources/layers, and report hover/click through here.

import { inject, type InjectionKey, type ShallowRef } from 'vue'
import type { Map as MlMap, MapLayerMouseEvent } from 'maplibre-gl'

export interface MapContext {
  map: ShallowRef<MlMap | null>
  /** Data layers are inserted below this basemap layer (place labels stay on top). */
  beforeId: string | undefined
  /** Layers whose clicks count as "on a feature" (so MapView can detect background clicks). */
  interactive: Set<string>
}

export const MAP_KEY: InjectionKey<MapContext> = Symbol('map')

export function useMap(): MapContext {
  const ctx = inject(MAP_KEY)
  if (!ctx) throw new Error('Map layer widgets must be placed inside <MapView>')
  return ctx
}

export interface HoverInfo {
  layerId: string
  featureId: string
  /** Pixel position within the map container. */
  x: number
  y: number
}

/**
 * Wire hover + click on a map layer. Maintains `hover` feature-state for
 * highlighting and reports feature ids (never MapLibre's flattened property
 * copies — callers look the original feature up by id).
 */
export function bindInteraction(
  map: MlMap,
  ctx: MapContext,
  layerId: string,
  sourceId: string,
  onHover: (h: HoverInfo | null) => void,
  onSelect: (id: string) => void,
): () => void {
  let hovered: string | number | null = null
  const clear = () => {
    if (hovered !== null) map.setFeatureState({ source: sourceId, id: hovered }, { hover: false })
    hovered = null
  }
  const move = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (!f || f.id === undefined) return
    if (hovered !== f.id) {
      clear()
      hovered = f.id
      map.setFeatureState({ source: sourceId, id: hovered }, { hover: true })
    }
    map.getCanvas().style.cursor = 'pointer'
    onHover({ layerId, featureId: String(f.id), x: e.point.x, y: e.point.y })
  }
  const leave = () => {
    clear()
    map.getCanvas().style.cursor = ''
    onHover(null)
  }
  const click = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (f?.id !== undefined) onSelect(String(f.id))
  }
  map.on('mousemove', layerId, move)
  map.on('mouseleave', layerId, leave)
  map.on('click', layerId, click)
  ctx.interactive.add(layerId)
  return () => {
    map.off('mousemove', layerId, move)
    map.off('mouseleave', layerId, leave)
    map.off('click', layerId, click)
    ctx.interactive.delete(layerId)
  }
}

export function setVisibility(map: MlMap, layerIds: string[], visible: boolean) {
  for (const id of layerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
}

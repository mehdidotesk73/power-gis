<script setup lang="ts">
// The map canvas. Layer widgets (ScalarLayer, VectorLayer) go in the default
// slot and render once the basemap has loaded. Overlays (tooltip, legend,
// panels) go in the `overlay` slot, positioned over the map.
import { Map as MlMap, NavigationControl, type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { onBeforeUnmount, onMounted, provide, ref, shallowRef } from 'vue'
import { MAP_KEY, type MapContext } from './mapContext'
import type { BBox } from '../../lib/geometry'
import { logDebug } from '../../debug'

const props = withDefaults(
  defineProps<{
    center?: [number, number]
    zoom?: number
    basemap?: 'light' | 'dark' | 'none'
  }>(),
  { center: () => [-96.5, 38.5], zoom: 3.2, basemap: 'light' },
)
const emit = defineEmits<{ (e: 'background-click'): void }>()

const LABELS = 'basemap-labels'

function basemapStyle(kind: 'light' | 'dark' | 'none'): StyleSpecification {
  const bg = kind === 'dark' ? '#1d2024' : '#f4f3ef'
  if (kind === 'none') return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': bg } }] }
  const base = kind === 'dark' ? 'dark_nolabels' : 'light_nolabels'
  const labels = kind === 'dark' ? 'dark_only_labels' : 'light_only_labels'
  const tiles = (set: string) => ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/${set}/{z}/{x}/{y}@2x.png`)
  const attribution = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>'
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: tiles(base), tileSize: 256, attribution },
      labels: { type: 'raster', tiles: tiles(labels), tileSize: 256 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': bg } },
      { id: 'basemap', type: 'raster', source: 'base' },
      { id: LABELS, type: 'raster', source: 'labels' },
    ],
  }
}

const el = ref<HTMLDivElement>()
const map = shallowRef<MlMap | null>(null)
const ctx: MapContext = { map, beforeId: props.basemap === 'none' ? undefined : LABELS, interactive: new Set() }
provide(MAP_KEY, ctx)

onMounted(() => {
  const m = new MlMap({
    container: el.value!,
    style: basemapStyle(props.basemap),
    center: props.center,
    zoom: props.zoom,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  })
  m.touchZoomRotate.disableRotation()
  m.addControl(new NavigationControl({ showCompass: false }), 'top-right')
  m.on('load', () => (map.value = m))
  m.on('error', (e) => logDebug(`map: ${e.error?.message ?? 'error'}`, 'warn'))
  m.on('click', (e) => {
    const layers = [...ctx.interactive].filter((id) => m.getLayer(id))
    if (!layers.length || !m.queryRenderedFeatures(e.point, { layers }).length) emit('background-click')
  })
})
onBeforeUnmount(() => map.value?.remove())

defineExpose({
  fitBounds(b: BBox, maxZoom = 8) {
    map.value?.fitBounds([b[0], b[1], b[2], b[3]], { padding: 40, maxZoom, duration: 600 })
  },
  getMap: () => map.value,
})
</script>

<template>
  <div class="map-root">
    <div ref="el" class="map-canvas" />
    <template v-if="map"><slot /></template>
    <slot name="overlay" />
  </div>
</template>

<style scoped>
.map-root {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 20rem;
  overflow: hidden;
  border-radius: 0.5rem;
  border: 1px solid var(--border);
}
.map-canvas {
  position: absolute;
  inset: 0;
}
</style>

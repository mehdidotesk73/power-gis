<script setup lang="ts">
// The map canvas. Layer widgets (ScalarLayer, VectorLayer) go in the default
// slot and render once the basemap has loaded. Overlays (tooltip, legend,
// panels) go in the `overlay` slot, positioned over the map.
import { Map as MlMap, NavigationControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre looks for its worker beside its own module, which doesn't exist once
// Vite bundles it — so emit the worker as an asset and point MapLibre at it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { onBeforeUnmount, onMounted, provide, ref, shallowRef } from 'vue'
import { MAP_KEY, type MapContext } from './mapContext'
import type { BBox } from '../../lib/geometry'
import { logDebug } from '../../debug'

const props = withDefaults(
  defineProps<{
    center?: [number, number]
    zoom?: number
    /** 'light' = OpenFreeMap Positron vector tiles (free, no API key); 'none' = plain background. */
    basemap?: 'light' | 'none'
  }>(),
  { center: () => [-96.5, 38.5], zoom: 3.2, basemap: 'light' },
)
const emit = defineEmits<{ (e: 'background-click'): void }>()

setWorkerUrl(workerUrl)

const BASEMAP_URL = 'https://tiles.openfreemap.org/styles/positron'
const BLANK: StyleSpecification = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f4f3ef' } }] }

const el = ref<HTMLDivElement>()
const map = shallowRef<MlMap | null>(null)
// beforeId is filled in on load: data layers go under the basemap's first label layer.
const ctx: MapContext = { map, beforeId: undefined, interactive: new Set() }
provide(MAP_KEY, ctx)

onMounted(() => {
  const m = new MlMap({
    container: el.value!,
    style: props.basemap === 'light' ? BASEMAP_URL : BLANK,
    center: props.center,
    zoom: props.zoom,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  })
  m.touchZoomRotate.disableRotation()
  m.addControl(new NavigationControl({ showCompass: false }), 'top-right')
  // Start fitted to the lower 48 so phones see both coasts.
  m.fitBounds([-124.8, 24.4, -66.9, 49.4], { padding: 12, animate: false })
  m.on('load', () => {
    ctx.beforeId = m.getStyle().layers.find((l) => l.type === 'symbol')?.id
    map.value = m
  })
  // If the basemap style itself can't load, fall back to a plain background
  // so the data layers still render.
  let fellBack = false
  m.on('error', (e) => {
    logDebug(`map: ${e.error?.message ?? 'error'}`, 'warn')
    if (!map.value && !fellBack && !m.isStyleLoaded()) {
      fellBack = true
      logDebug('basemap unavailable — showing data on a plain background', 'warn')
      m.setStyle(BLANK, { diff: false })
    }
  })
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

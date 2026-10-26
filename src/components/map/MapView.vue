<script setup lang="ts">
// The map canvas. Layer widgets (ScalarLayer, VectorLayer) go in the default
// slot and render once the basemap has loaded. Overlays (tooltip, legend,
// panels) go in the `overlay` slot, positioned over the map.
import { MAP_BG } from '../../lib/mapTheme'
import { Map as MlMap, NavigationControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre looks for its worker beside its own module, which doesn't exist once
// Vite bundles it — so emit the worker as an asset and point MapLibre at it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { onBeforeUnmount, onMounted, provide, ref, shallowRef } from 'vue'
import { DRAW_ORDER, MAP_KEY, slotId, type MapContext } from './mapContext'
import type { BBox } from '../../lib/geometry'
import { logDebug } from '../../debug'

const props = withDefaults(
  defineProps<{
    center?: [number, number]
    zoom?: number
    /** 'light' = OpenFreeMap Positron vector tiles (free, no API key); 'none' = plain background. */
    basemap?: 'dark' | 'none'
  }>(),
  { center: () => [-96.5, 38.5], zoom: 3.2, basemap: 'dark' },
)
const emit = defineEmits<{ (e: 'background-click'): void }>()

setWorkerUrl(workerUrl)

// Dark basemaps, tried in order (free, no key); if neither loads, a plain background.
const BASEMAPS = ['https://tiles.openfreemap.org/styles/dark', 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json']
const BLANK: StyleSpecification = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': MAP_BG } }] }

const el = ref<HTMLDivElement>()
const map = shallowRef<MlMap | null>(null)
// Draw-order slots are added on load, under the basemap's first label layer.
// Widgets mount (and re-add pattern layers) on their own schedule, so the
// last requested order is kept and re-applied whenever one changes.
let lastOrder: string[] = []
let restackQueued = false
const ctx: MapContext = {
  map,
  slot: (kind) => slotId(kind),
  interactive: new Set(),
  stacks: new Map(),
  restackSoon: () => {
    if (restackQueued) return
    restackQueued = true
    queueMicrotask(() => {
      restackQueued = false
      applyOrder()
    })
  },
}

function applyOrder() {
  const m = map.value
  if (!m) return
  // Moving each widget just under its kind's slot, bottom of the list first,
  // leaves the list's top widget highest.
  for (const id of [...lastOrder].reverse()) {
    const s = ctx.stacks.get(id)
    if (!s) continue
    for (const layerId of s.layerIds()) if (m.getLayer(layerId)) m.moveLayer(layerId, slotId(s.kind))
  }
}
provide(MAP_KEY, ctx)

let resizer: ResizeObserver | null = null
onMounted(() => {
  const m = new MlMap({
    container: el.value!,
    style: props.basemap === 'dark' ? BASEMAPS[0] : BLANK,
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
    // Invisible marker layers; each data layer is inserted just under its kind's marker.
    const labels = m.getStyle().layers.find((l) => l.type === 'symbol')?.id
    for (const kind of DRAW_ORDER) m.addLayer({ id: slotId(kind), type: 'background', layout: { visibility: 'none' } }, labels)
    map.value = m
  })
  // If a basemap style can't load, try the next one, then a plain background,
  // so the data layers still render.
  let next = props.basemap === 'dark' ? 1 : BASEMAPS.length + 1
  m.on('error', (e) => {
    logDebug(`map: ${e.error?.message ?? 'error'}`, 'warn')
    if (map.value || m.isStyleLoaded() || next > BASEMAPS.length) return
    const style = BASEMAPS[next++]
    logDebug(style ? `basemap unavailable — trying ${new URL(style).host}` : 'basemap unavailable — showing data on a plain background', 'warn')
    m.setStyle(style ?? BLANK, { diff: false })
  })
  // The container changes size without the window doing so (the side panel's
  // splitter, the controls popping out): keep the canvas matched to it.
  resizer = new ResizeObserver(() => m.resize())
  resizer.observe(el.value!)
  m.on('click', (e) => {
    const layers = [...ctx.interactive].filter((id) => m.getLayer(id))
    if (!layers.length || !m.queryRenderedFeatures(e.point, { layers }).length) emit('background-click')
  })
})
onBeforeUnmount(() => {
  resizer?.disconnect()
  map.value?.remove()
})

defineExpose({
  fitBounds(b: BBox, maxZoom = 8) {
    map.value?.fitBounds([b[0], b[1], b[2], b[3]], { padding: 40, maxZoom, duration: 600 })
  },
  getMap: () => map.value,
  /** Stack widget layers to match a list, first = on top (within each draw kind). */
  restack(idsTopFirst: string[]) {
    lastOrder = [...idsTopFirst]
    applyOrder()
  },
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

// Visualizations drawn on a map of their own, off screen, as a PNG with their
// legend: the page's map is never touched. A story's map figures are made this
// way from their settings, and a visualization's "Copy as image" uses it to show
// it alone.
import { createApp, defineComponent, h, nextTick, ref, type Ref } from 'vue'
import VisualizationMap from './VisualizationMap.vue'
import { legendOf, useVisualizationLayers } from './useVisualizationLayers'
import type { VisualizationSpec } from '../../lib/dataset/visualization'
import { bboxOf, focusBox } from '../../lib/geometry'
import type { DatasetRecord } from '../../shared/records'
import type { Map as MlMap } from 'maplibre-gl'

const until = (what: string, ok: () => boolean, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => (ok() ? resolve() : Date.now() - t0 > ms ? reject(new Error(`${what} took too long`)) : setTimeout(tick, 50))
    tick()
  })
const idle = (m: MlMap, ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms) // tiles that never come still leave a picture of the data
    m.once('idle', () => (clearTimeout(t), resolve()))
    m.triggerRepaint()
  })

export interface ImageOptions {
  width?: number
  height?: number
  /** Names of features (their label) left off the map. */
  hide?: string[]
  /** `main` (default): fit the main group of features (far-off ones out of view); `all`: every feature. */
  fit?: 'main' | 'all'
  /** Exactly this view instead of the fit (a story map's viewport, shared with its live map). */
  viewport?: Viewport
}

/**
 * Where a map looks: its center and zoom, and the width (page pixels) it was taken at. Shown at another width the
 * zoom moves by log2 of the ratio, so the same stretch of ground fills the frame: a story map's picture and its live
 * map hand this back and forth, so both always show the same window.
 */
export interface Viewport {
  center: [number, number]
  zoom: number
  width: number
}
export const viewportOf = (m: MlMap): Viewport => {
  const c = m.getCenter()
  return { center: [c.lng, c.lat], zoom: m.getZoom(), width: m.getContainer().clientWidth }
}
export const showViewport = (m: MlMap, v: Viewport) => {
  const w = m.getContainer().clientWidth
  m.jumpTo({ center: v.center, zoom: v.zoom + (w > 0 && v.width > 0 ? Math.log2(w / v.width) : 0) })
}

/** `visualizations` (first on top) drawn alone, fitted to their features, `width` × `height` page pixels. */
export async function visualizationsPng(visualizations: VisualizationSpec[], records: Map<string, DatasetRecord>, opts: ImageOptions = {}): Promise<Blob> {
  return (await visualizationsPicture(visualizations, records, opts)).png
}

/** The same, with the viewport the picture shows. */
export async function visualizationsPicture(visualizations: VisualizationSpec[], records: Map<string, DatasetRecord>, opts: ImageOptions = {}): Promise<{ png: Blob; viewport: Viewport }> {
  const size = { width: opts.width ?? 720, height: opts.height ?? 480 }
  const hidden = new Set((opts.hide ?? []).map((h) => h.trim().toLowerCase()))
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', width: `${size.width}px`, height: `${size.height}px`, pointerEvents: 'none' })
  document.body.appendChild(host)
  let api: { map: Ref<InstanceType<typeof VisualizationMap> | undefined>; layers: ReturnType<typeof useVisualizationLayers>; shown: () => ReturnType<typeof useVisualizationLayers>['rendered']['value'] } | undefined
  const app = createApp(
    defineComponent({
      setup() {
        const map = ref<InstanceType<typeof VisualizationMap>>()
        const layers = useVisualizationLayers(ref(visualizations.map((v) => ({ ...v, visible: true }))), ref(records))
        // Features named in `hide` are left out of what's drawn (and of the fit and the legend).
        const shown = () =>
          hidden.size
            ? layers.rendered.value.map((r) => ({ ...r, data: { ...r.data, features: r.data.features.filter((f) => !hidden.has(String(f.properties._label ?? '').trim().toLowerCase())) } }))
            : layers.rendered.value
        api = { map, layers, shown }
        return () => h('div', { style: 'width:100%;height:100%' }, [h(VisualizationMap, { ref: map, rendered: shown(), fill: true })])
      },
    }),
  )
  try {
    app.mount(host)
    const a = api!
    const want = visualizations.filter((v) => records.has(v.datasetId)).length
    if (!want) throw new Error('none of these visualizations’ datasets is on this device')
    await until('the map', () => !!a.map.value?.getMap(), 20000)
    await a.layers.settled()
    if (a.layers.rendered.value.length < want) throw new Error('some visualizations’ values couldn’t be read (View logs)')
    await nextTick() // the layers mount onto the map
    const m = a.map.value!.getMap()!
    const geoms = a.shown().flatMap((r) => r.data.features.map((f) => f.geometry))
    const box = opts.fit === 'all' ? bboxOf(geoms) : focusBox(geoms)
    m.resize() // its container's size, before fitting to it
    if (opts.viewport) showViewport(m, opts.viewport)
    else if (box) m.fitBounds([box[0], box[1], box[2], box[3]], { padding: 24, maxZoom: 8, animate: false })
    await idle(m, 8000)
    return { png: await a.map.value!.png(legendOf(a.shown())), viewport: viewportOf(m) }
  } finally {
    app.unmount()
    host.remove()
  }
}

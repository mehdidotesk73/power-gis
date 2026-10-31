// Visualizations drawn on a map of their own, off screen, as a PNG with their
// legend: the page's map is never touched. A story's map figures are made this
// way from their settings, and a visualization's "Copy as image" uses it to show
// it alone.
import { createApp, defineComponent, h, nextTick, ref, type Ref } from 'vue'
import VisualizationMap from './VisualizationMap.vue'
import { useVisualizationLayers } from './useVisualizationLayers'
import type { VisualizationSpec } from '../../lib/dataset/visualization'
import { focusBox } from '../../lib/geometry'
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

/** `visualizations` (first on top) drawn alone, fitted to their features, `width` × `height` page pixels. */
export async function visualizationsPng(visualizations: VisualizationSpec[], records: Map<string, DatasetRecord>, size = { width: 720, height: 480 }): Promise<Blob> {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', width: `${size.width}px`, height: `${size.height}px`, pointerEvents: 'none' })
  document.body.appendChild(host)
  let api: { map: Ref<InstanceType<typeof VisualizationMap> | undefined>; layers: ReturnType<typeof useVisualizationLayers> } | undefined
  const app = createApp(
    defineComponent({
      setup() {
        const map = ref<InstanceType<typeof VisualizationMap>>()
        const layers = useVisualizationLayers(ref(visualizations.map((v) => ({ ...v, visible: true }))), ref(records))
        api = { map, layers }
        return () => h('div', { style: 'width:100%;height:100%' }, [h(VisualizationMap, { ref: map, rendered: layers.rendered.value })])
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
    const box = focusBox(a.layers.rendered.value.flatMap((r) => r.data.features.map((f) => f.geometry)))
    m.resize() // its container's size, before fitting to it
    if (box) m.fitBounds([box[0], box[1], box[2], box[3]], { padding: 24, maxZoom: 8, animate: false })
    await idle(m, 8000)
    return await a.map.value!.png(a.layers.legend.value)
  } finally {
    app.unmount()
    host.remove()
  }
}

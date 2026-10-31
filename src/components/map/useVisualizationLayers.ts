// Visualizations → what a map draws: each one's values from the server (one
// request per dataset + binding + column + aggregation, cached; restyling never
// refetches), the layers in list order, and their legend. Used by the page's map
// and by maps drawn off screen (stories), so any list of visualizations draws the
// same way wherever it is.
import { computed, shallowRef, watch, type Ref } from 'vue'
import { request } from '../../client/api'
import { logDebug } from '../../debug'
import { visualizationLayer, VALUE, type VisualizationSpec } from '../../lib/dataset/visualization'
import { fieldLabel, type LayerData, type LayerFeature } from '../../lib/schema'
import { colorLegend, MAGNITUDE_FIELD, patternLegend, vectorOf, type LegendEntry } from '../../lib/style'
import type { DatasetRecord } from '../../shared/records'

/** One visualization ready to draw: its settings, its dataset, its features. */
export interface RenderedViz {
  layer: VisualizationSpec
  ds: DatasetRecord
  data: LayerData
}

export function useVisualizationLayers(visualizations: Ref<VisualizationSpec[]>, records: Ref<Map<string, DatasetRecord>>) {
  const valuesCache = new Map<string, Promise<LayerData | null>>()
  const layers = shallowRef(new Map<string, { key: string; data: LayerData; byKey: Map<string, LayerFeature> }>())

  // Keyed by the dataset's updatedAt too: a transform re-run rewrites the table.
  const queryKey = (v: VisualizationSpec) => `${v.datasetId}|${records.value.get(v.datasetId)?.updatedAt}|${JSON.stringify(v.binding)}|${v.column}|${v.aggregation}`
  const layerKey = (v: VisualizationSpec) => `${queryKey(v)}|${v.name}|${records.value.get(v.datasetId)?.name}`

  function fetchLayer(v: VisualizationSpec): Promise<LayerData | null> {
    const k = queryKey(v)
    let p = valuesCache.get(k)
    if (!p) {
      p = (async () => {
        const r = await request('queryVisualization', { datasetId: v.datasetId, binding: v.binding, column: v.column, aggregation: v.aggregation })
        if (!r.ok) {
          logDebug(`values for "${v.name}": ${r.error.message}`, 'error')
          return null
        }
        const values = r.data
        if (values.unmatched) logDebug(`"${v.name}": ${values.unmatched} rows had no feature (e.g. ${values.unmatchedSamples.slice(0, 5).join(', ')})`, 'warn')
        return visualizationLayer(values, v, '')
      })()
      p.then((x) => x || valuesCache.delete(k))
      valuesCache.set(k, p)
    }
    return p
  }

  const vizById = computed(() => new Map(visualizations.value.map((v) => [v.id, v])))
  /** Resolves once every visualization whose dataset is here has its layer (or failed). */
  let settled: Promise<void> = Promise.resolve()
  watch(
    () => visualizations.value.map(layerKey).join('\n'),
    () => {
      settled = (async () => {
        for (const v of visualizations.value) {
          if (!records.value.has(v.datasetId)) continue // unavailable here (or not loaded yet): nothing to draw
          const key = layerKey(v)
          if (layers.value.get(v.id)?.key === key) continue
          const raw = await fetchLayer(v)
          const now = vizById.value.get(v.id)
          if (!raw || !now || layerKey(now) !== key) continue
          const ds = records.value.get(v.datasetId)
          const data: LayerData = { ...raw, id: v.id, name: `${ds?.name ?? ''} · ${v.name}`, fields: raw.fields.map((f) => (f.name === VALUE ? { ...f, alias: v.name } : f)) }
          layers.value = new Map(layers.value).set(v.id, { key, data, byKey: new Map(data.features.map((f) => [String(f.id), f])) })
        }
      })()
    },
    { immediate: true },
  )

  const rendered = computed<RenderedViz[]>(() =>
    visualizations.value.flatMap((l) => {
      const e = layers.value.get(l.id)
      const ds = records.value.get(l.datasetId)
      return e && ds ? [{ layer: l, ds, data: e.data }] : []
    }),
  )
  const renderedById = computed(() => new Map(rendered.value.map((r) => [r.layer.id, r])))

  const legend = computed<LegendEntry[]>(() => {
    const out: LegendEntry[] = []
    const shown = rendered.value.filter((r) => r.layer.visible)
    const many = new Set(shown.map((r) => r.ds.id)).size > 1
    for (const { layer: l, ds, data } of shown) {
      const title = many ? `${ds.name}: ${l.name}` : l.name
      if (l.kind === 'scalar') {
        const e = colorLegend(l.style.color, data.features, title)
        if (e) out.push(e)
        const p = l.style.pattern
        if (p.kind === 'field') {
          const fd = data.fields.find((f) => f.name === p.field)
          const pe = patternLegend(p, `${title} — pattern${fd && fd.name !== VALUE ? `: ${fieldLabel(fd)}` : ''}`)
          if (pe) out.push(pe)
        }
      } else if (l.style.color.kind !== 'constant') {
        const mags = data.features.map((f) => ({ ...f, properties: { [MAGNITUDE_FIELD]: vectorOf(f.properties, l.style.components)?.magnitude ?? null } }))
        const e = colorLegend(l.style.color, mags, `${title} (magnitude)`)
        if (e) out.push(e)
      }
    }
    return out
  })

  return { layers, rendered, renderedById, legend, vizById, settled: () => settled }
}

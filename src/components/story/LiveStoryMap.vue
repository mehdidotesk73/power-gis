<script setup lang="ts">
// A story's map figure brought to life: the same visualization, locked (its
// settings, the places it leaves out, its framing), on a live map you can pan
// and zoom. Tap a region for its value and the rows behind it. Release puts
// the current view back as a picture. Nothing here is stored: the story keeps
// only the figure's settings, so a reload shows it as it was written.
import { computed, onMounted, ref, shallowRef, toRef, watch } from 'vue'
import VisualizationMap from '../map/VisualizationMap.vue'
import MapLegend from '../map/MapLegend.vue'
import FeatureRows from '../dataset/FeatureRows.vue'
import UiButton from '../ui/UiButton.vue'
import { legendOf, useVisualizationLayers } from '../map/useVisualizationLayers'
import { request } from '../../client/api'
import { bboxOf, focusBox } from '../../lib/geometry'
import { formatPrimitive } from '../../lib/format'
import { VALUE, type VisualizationSpec } from '../../lib/dataset/visualization'
import { ROW_COUNT } from '../../lib/dataset/dataset'
import type { DataRecord } from '../../lib/data/connectors'
import type { Figure } from '../../lib/story/story'
import type { DatasetRecord } from '../../shared/records'
import { logDebug } from '../../debug'

const props = defineProps<{ figure: Extract<Figure, { kind: 'map' }>; records: Map<string, DatasetRecord> }>()
const emit = defineEmits<{ (e: 'release', picture: Blob | null): void }>()

const viz = computed(() => ({ ...props.figure.viz, id: 'story-live', visible: true }) as VisualizationSpec)
const layers = useVisualizationLayers(ref([viz.value]), toRef(props, 'records'))
const hidden = computed(() => new Set((props.figure.hide ?? []).map((h) => h.trim().toLowerCase())))
// Features the figure leaves out stay out here too (and out of the fit and the legend).
const shown = computed(() =>
  hidden.value.size
    ? layers.rendered.value.map((r) => ({ ...r, data: { ...r.data, features: r.data.features.filter((f) => !hidden.value.has(String(f.properties._label ?? '').trim().toLowerCase())) } }))
    : layers.rendered.value,
)
const legend = computed(() => legendOf(shown.value))
const map = ref<InstanceType<typeof VisualizationMap>>()

// Framed as the picture was: the main group of features (or all of them).
let fitted = false
function fit() {
  const m = map.value?.getMap()
  if (fitted || !m || !shown.value.length) return
  const geoms = shown.value.flatMap((r) => r.data.features.map((f) => f.geometry))
  const box = props.figure.fit === 'all' ? bboxOf(geoms) : focusBox(geoms)
  if (!box) return
  fitted = true
  m.resize()
  m.fitBounds([box[0], box[1], box[2], box[3]], { padding: 24, maxZoom: 8, animate: false })
}
watch([shown, () => map.value?.getMap()], fit, { flush: 'post' })
onMounted(() => void layers.settled().then(fit))

// ── tap a region ──────────────────────────────────────────────────────────

const picked = ref<string | null>(null)
const rows = shallowRef<DataRecord[] | null>(null)
const card = computed(() => {
  const r = shown.value[0]
  const f = picked.value && r?.data.features.find((x) => String(x.id) === picked.value)
  if (!r || !f) return null
  return { title: String(f.properties._label ?? ''), value: formatPrimitive(f.properties[VALUE], r.data.fields[0].type), rowCount: Number(f.properties[ROW_COUNT] ?? 0), columns: r.ds.columns }
})
async function pick(key: string) {
  picked.value = key
  rows.value = null
  const r = await request('featureRows', { datasetId: viz.value.datasetId, binding: viz.value.binding, key })
  if (picked.value !== key) return
  rows.value = r.ok ? r.data : []
  if (!r.ok) logDebug(`story map rows: ${r.error.message}`, 'error')
}

// ── release: the view as it is now, as a picture ──────────────────────────

const releasing = ref(false)
async function release() {
  releasing.value = true
  let picture: Blob | null = null
  try {
    picture = (await map.value?.png(legend.value)) ?? null
  } catch (e) {
    logDebug(`story map picture: ${(e as Error).message}`, 'warn')
  }
  emit('release', picture)
}
defineExpose({ release })
</script>

<template>
  <div class="live" data-testid="story.livemap">
    <VisualizationMap ref="map" :rendered="shown" cooperative @select="(_l, id) => pick(id)" @background-click="picked = null">
      <template #overlay>
        <MapLegend :entries="legend" />
        <UiButton class="release" size="compact" tone="primary" data-testid="story.release" :disabled="releasing" @click="release">{{ releasing ? 'Releasing…' : 'Release' }}</UiButton>
        <div v-if="card" class="card" data-testid="story.featurecard">
          <div class="card-head">
            <strong>{{ card.title }}</strong>
            <button class="x" aria-label="Close" @click="picked = null">✕</button>
          </div>
          <p class="value"><span class="muted">{{ figure.viz.name }}:</span> {{ card.value }}</p>
          <p v-if="!rows" class="muted small">Loading its rows…</p>
          <div v-else-if="rows.length" class="rows"><FeatureRows :columns="card.columns" :rows="rows" /></div>
        </div>
      </template>
    </VisualizationMap>
  </div>
</template>

<style scoped>
.live {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 2;
  border-radius: var(--radius);
  overflow: hidden;
}
.live :deep(.legend) {
  max-width: 60%;
}
.release {
  position: absolute;
  right: 0.5rem;
  bottom: 1.6rem;
  z-index: 3;
}
.card {
  position: absolute;
  left: 0.5rem;
  right: 0.5rem;
  bottom: 3.6rem;
  max-height: 55%;
  overflow: auto;
  z-index: 3;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  font-size: 0.78rem;
  box-shadow: 0 6px 18px rgb(0 0 0 / 0.45);
}
.card-head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}
.x {
  border: 0;
  background: none;
  color: var(--text-muted);
  font-size: 0.9rem;
  cursor: pointer;
}
.value {
  margin: 0.2rem 0;
}
.muted {
  color: var(--text-muted);
}
.small {
  font-size: 0.72rem;
  margin: 0;
}
.rows {
  max-height: 10rem;
  overflow: auto;
}
</style>

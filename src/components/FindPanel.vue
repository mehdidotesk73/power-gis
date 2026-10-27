<script setup lang="ts">
// Find features in a visualization: search (typo-tolerant) every feature's
// name and every text value in the rows behind its features — all of them,
// or one column — e.g. a
// utility's name finds all the counties it serves. Picking a match tells the
// page which features have it; the page highlights and zooms to them.
import { computed, ref, watch } from 'vue'
import SearchBox from './map/SearchBox.vue'
import { request } from '../client/api'
import { LABEL_COLUMN, type FindEntry } from '../lib/dataset/query'
import type { VisualizationSpec } from '../lib/dataset/visualization'

export interface Found {
  vizId: string
  column: string
  value: string
  keys: string[]
}

const props = defineProps<{
  /** Visualizations that can be searched (drawn), top first. */
  visualizations: { viz: VisualizationSpec; label: string }[]
  found: Found | null
}>()
const emit = defineEmits<{ (e: 'found', f: Found): void; (e: 'clear'): void }>()

const vizId = ref('')
const picked = ref(false) // the user chose one: keep it while it exists
// Until then, follow the top visible visualization (they load one by one).
watch(
  () => props.visualizations.map((x) => x.viz.id + (x.viz.visible ? '+' : '')).join('|'),
  () => {
    if (picked.value && props.visualizations.some((x) => x.viz.id === vizId.value)) return
    picked.value = false
    vizId.value = (props.visualizations.find((x) => x.viz.visible) ?? props.visualizations[0])?.viz.id ?? ''
  },
  { immediate: true },
)
const current = computed(() => props.visualizations.find((x) => x.viz.id === vizId.value)?.viz)

const entries = ref<FindEntry[]>([])
const loading = ref(false)
const error = ref('')
let seq = 0
watch(
  () => (current.value ? `${current.value.datasetId}|${JSON.stringify(current.value.binding)}` : ''),
  async (k) => {
    const mine = ++seq
    entries.value = []
    error.value = ''
    const v = current.value
    if (!k || !v) return
    loading.value = true
    const r = await request('findIndex', { datasetId: v.datasetId, binding: v.binding })
    if (mine !== seq) return
    loading.value = false
    if (r.ok) entries.value = r.data.entries
    else error.value = r.error.message
  },
  { immediate: true },
)

const columnName = (c: string) => (c === LABEL_COLUMN ? 'name' : c.replace(/_/g, ' '))

// Search all data, or one column (feature names count as a column).
const ALL = ''
const column = ref(ALL)
const columns = computed(() => {
  const set = new Set(entries.value.map((e) => e.column))
  return [...set].sort((a, b) => (a === LABEL_COLUMN ? -1 : b === LABEL_COLUMN ? 1 : a.localeCompare(b)))
})
watch(columns, (cs) => cs.includes(column.value) || (column.value = ALL))
const shown = computed(() => (column.value === ALL ? entries.value : entries.value.filter((e) => e.column === column.value)))
const detail = (e: FindEntry) => `${columnName(e.column)} · ${e.features.toLocaleString()} feature${e.features === 1 ? '' : 's'}`

const box = ref<{ clear: () => void }>()
async function pick(e: FindEntry) {
  const v = current.value
  if (!v) return
  const r = await request('findFeatures', { datasetId: v.datasetId, binding: v.binding, column: e.column, value: e.value })
  if (r.ok) emit('found', { vizId: v.id, column: e.column, value: e.value, keys: r.data.keys })
  else error.value = r.error.message
}
function clear() {
  box.value?.clear()
  emit('clear')
}
</script>

<template>
  <section class="find" aria-label="Search">
    <div class="sentence">
      <span class="lbl">Search in</span>
      <select v-model="vizId" class="viz" aria-label="Visualization to search" @change="picked = true" :disabled="!visualizations.length">
        <option v-if="!visualizations.length" value="">no visualization</option>
        <option v-for="x in visualizations" :key="x.viz.id" :value="x.viz.id">{{ x.label }}</option>
      </select>
      <span class="lbl">in</span>
      <select v-model="column" class="col" aria-label="Column to search" :disabled="!entries.length">
        <option :value="ALL">All data</option>
        <option v-for="c in columns" :key="c" :value="c">{{ c === LABEL_COLUMN ? 'Feature names' : columnName(c) }}</option>
      </select>
    </div>
    <SearchBox
      ref="box"
      :items="shown"
      :text="(e) => e.value"
      :detail="detail"
      :placeholder="loading ? 'Indexing…' : 'Search (typos OK)'"
      fuzzy
      @pick="pick"
    />
    <p v-if="error" class="err">{{ error }}</p>
    <div v-if="found" class="chip">
      <div>
        <strong>{{ found.value }}</strong>
        <div class="muted">{{ columnName(found.column) }} · {{ found.keys.length.toLocaleString() }} feature{{ found.keys.length === 1 ? '' : 's' }} highlighted</div>
      </div>
      <button aria-label="Clear" @click="clear">✕</button>
    </div>
  </section>
</template>

<style scoped>
/* Its own card, set apart from the workspace panels below. */
.find {
  display: grid;
  grid-template-columns: minmax(0, 1fr); /* never wider than the side panel */
  gap: 0.35rem;
  padding: 0.45rem 0.5rem;
  border: 1px solid color-mix(in srgb, var(--accent-blue) 45%, var(--border));
  border-radius: 0.6rem;
  background: color-mix(in srgb, var(--accent-blue) 7%, var(--bg));
}
.sentence {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem 0.35rem;
}
.lbl {
  font-size: 0.76rem;
  font-weight: 600;
  color: var(--text-muted);
  white-space: nowrap;
}
select {
  min-width: 0;
  padding: 0.12rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 16px; /* iOS zooms into smaller fields */
}
select.viz {
  flex: 1 1 9rem;
}
select.col {
  flex: 1 1 6rem;
}
/* Compact search field (SearchBox's own input). */
.find :deep(input) {
  padding: 0.28rem 0.5rem;
}
/* With a mouse there's no iOS zoom to dodge: smaller text throughout. */
@media (pointer: fine) {
  select,
  .find :deep(input) {
    font-size: 0.8rem;
  }
}
.err {
  margin: 0;
  color: var(--danger);
  font-size: 0.74rem;
}
.chip {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--accent-blue);
  border-radius: 0.4rem;
  background: var(--bg);
}
.chip button {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1rem;
}
.muted {
  color: var(--text-muted);
  font-size: 0.74rem;
}
</style>

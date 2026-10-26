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
// Default to the top visible visualization; keep the pick while it exists.
watch(
  () => props.visualizations.map((x) => x.viz.id + (x.viz.visible ? '+' : '')).join('|'),
  () => {
    if (props.visualizations.some((x) => x.viz.id === vizId.value)) return
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
  <div class="find">
    <div class="top">
      <span class="lbl">Find</span>
      <select v-model="vizId" aria-label="Visualization to search" :disabled="!visualizations.length">
        <option v-for="x in visualizations" :key="x.viz.id" :value="x.viz.id">{{ x.label }}</option>
      </select>
    </div>
    <label class="in">
      in
      <select v-model="column" aria-label="Column to search" :disabled="!entries.length">
        <option :value="ALL">All data</option>
        <option v-for="c in columns" :key="c" :value="c">{{ c === LABEL_COLUMN ? 'Feature names' : columnName(c) }}</option>
      </select>
    </label>
    <SearchBox
      ref="box"
      :items="shown"
      :text="(e) => e.value"
      :detail="detail"
      :placeholder="loading ? 'Indexing…' : 'Search names and values (typos OK)'"
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
  </div>
</template>

<style scoped>
.find {
  display: grid;
  gap: 0.35rem;
}
.top {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.lbl {
  font-weight: 600;
}
select {
  flex: 1;
  min-width: 0;
  width: 0;
  padding: 0.3rem;
  font-size: 16px;
}
.in {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-muted);
  font-size: 0.85rem;
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

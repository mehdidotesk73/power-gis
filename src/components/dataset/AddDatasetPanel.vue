<script setup lang="ts">
// Add a dataset to the workspace: upload a table (built-in, CSV, GeoJSON /
// Esri JSON, ArcGIS URL) — the server stores it as a new table and returns
// its id — or pick one already in the database. How its rows map to
// features is chosen per visualization.
import { computed, onMounted, ref } from 'vue'
import { request } from '../../client/api'
import { readDb } from '../../client/db'
import type { UploadSource } from '../../shared/api'
import { BUILTIN_TABLES } from '../../shared/builtins'
import type { DatasetRecord } from '../../shared/records'

const props = defineProps<{ inWorkspace: string[] }>()
const emit = defineEmits<{ (e: 'add', datasetId: string): void; (e: 'cancel'): void }>()

type Origin = 'builtin' | 'csv' | 'json' | 'arcgis' | 'db'
const origin = ref<Origin>('builtin')
const builtin = ref(BUILTIN_TABLES[0].table)
const arcgisUrl = ref('')
const name = ref('')
const busy = ref(false)
const error = ref('')

async function upload(source: UploadSource) {
  busy.value = true
  error.value = ''
  const r = await request('uploadDataset', { source, name: name.value.trim() || undefined })
  busy.value = false
  if (r.ok) emit('add', r.data.datasetId)
  else error.value = r.error.message
}
function onFile(e: Event, kind: 'csv' | 'json') {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (f) upload({ kind, file: f })
}

// ── already in the database ────────────────────────────────────────────────

const stored = ref<DatasetRecord[]>([])
const available = computed(() => stored.value.filter((d) => !props.inWorkspace.includes(d.id)))
async function refresh() {
  try {
    stored.value = (await readDb.list('datasets')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch (e) {
    error.value = (e as Error).message
  }
}
onMounted(refresh)
async function deleteStored(d: DatasetRecord) {
  if (!confirm(`Delete "${d.name}" from the database? Visualizations of it in other workspaces go too.`)) return
  const r = await request('deleteDataset', { id: d.id })
  if (!r.ok) error.value = r.error.message
  await refresh()
}
</script>

<template>
  <div class="add">
    <div class="seg">
      <button :class="{ on: origin === 'builtin' }" @click="origin = 'builtin'">Built-in</button>
      <button :class="{ on: origin === 'csv' }" @click="origin = 'csv'">CSV file</button>
      <button :class="{ on: origin === 'json' }" @click="origin = 'json'">GeoJSON / Esri</button>
      <button :class="{ on: origin === 'arcgis' }" @click="origin = 'arcgis'">ArcGIS URL</button>
      <button :class="{ on: origin === 'db' }" @click="(origin = 'db'), refresh()">Saved</button>
    </div>
    <template v-if="origin !== 'db'">
      <label class="row">Name <input v-model="name" type="text" placeholder="(from the source)" /></label>
      <div v-if="origin === 'builtin'" class="row">
        <select v-model="builtin">
          <option v-for="b in BUILTIN_TABLES" :key="b.table" :value="b.table">{{ b.label }}</option>
        </select>
        <button class="btn primary" :disabled="busy" @click="upload({ kind: 'builtin', table: builtin })">Add</button>
      </div>
      <label v-else-if="origin === 'csv'" class="btn file">
        <input type="file" accept=".csv,text/csv" :disabled="busy" @change="onFile($event, 'csv')" />
        Choose a CSV…
      </label>
      <label v-else-if="origin === 'json'" class="btn file">
        <input type="file" accept=".json,.geojson,application/json,application/geo+json" :disabled="busy" @change="onFile($event, 'json')" />
        Choose a .geojson / Esri .json…
      </label>
      <form v-else class="row" @submit.prevent="arcgisUrl.trim() && upload({ kind: 'arcgis', url: arcgisUrl.trim() })">
        <input v-model="arcgisUrl" type="url" placeholder="https://…/FeatureServer/0" autocapitalize="off" />
        <button class="btn primary" type="submit" :disabled="busy">Add</button>
      </form>
      <p class="muted small">{{ busy ? 'Uploading…' : 'Stored as a new table in the database (on this device for now).' }}</p>
    </template>
    <template v-else>
      <p v-if="!available.length" class="muted small">No other datasets in the database.</p>
      <ul class="stored">
        <li v-for="d in available" :key="d.id">
          <span class="grow">
            <strong>{{ d.name }}</strong>
            <span class="muted small">{{ d.rowCount.toLocaleString() }} rows · {{ d.origin }}</span>
          </span>
          <button class="btn primary" @click="emit('add', d.id)">Add</button>
          <button class="icon" title="Delete from the database" @click="deleteStored(d)">🗑</button>
        </li>
      </ul>
    </template>
    <p v-if="error" class="error small">{{ error }}</p>
    <button class="btn link" @click="emit('cancel')">Cancel</button>
  </div>
</template>

<style scoped>
.add {
  display: grid;
  gap: 0.45rem;
  font-size: 0.82rem;
}
.seg {
  display: flex;
  flex-wrap: wrap;
}
.seg button {
  flex: 1;
  padding: 0.35rem 0.3rem;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.75rem;
}
.seg button + button {
  border-left: none;
}
.seg button:first-child {
  border-radius: 0.35rem 0 0 0.35rem;
}
.seg button:last-child {
  border-radius: 0 0.35rem 0.35rem 0;
}
.seg button.on {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: var(--on-accent);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.row.end {
  justify-content: flex-end;
}
.row select,
.row input {
  min-width: 0;
  flex: 1;
  max-width: 13rem;
  padding: 0.3rem;
  font-size: 0.85rem;
}
form.row input {
  max-width: none;
}
.check {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
.lbl {
  font-weight: 600;
  margin-top: 0.2rem;
}
.btn {
  padding: 0.35rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.8rem;
  cursor: pointer;
}
.btn.primary {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: var(--on-accent);
}
.btn.primary:disabled {
  opacity: 0.5;
}
.btn.link {
  border: none;
  background: none;
  color: var(--text-muted);
  justify-self: start;
  padding: 0;
}
.vec {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr auto;
  gap: 0.25rem;
  margin-bottom: 0.25rem;
}
.vec input,
.vec select {
  min-width: 0;
  padding: 0.25rem;
  font-size: 0.8rem;
}
.icon {
  background: none;
  border: none;
  color: var(--text-muted);
}
.add-vec {
  color: var(--accent-blue);
}
.file input {
  display: none;
}
.stored {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.35rem;
}
.stored li {
  display: flex;
  gap: 0.35rem;
  align-items: center;
}
.grow {
  flex: 1;
  display: grid;
  min-width: 0;
}
.muted {
  color: var(--text-muted);
}
.small {
  font-size: 0.75rem;
  margin: 0;
}
.ok {
  color: var(--ok);
}
.bad,
.error {
  color: var(--danger);
}
</style>

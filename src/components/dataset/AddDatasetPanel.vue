<script setup lang="ts">
// Add a dataset to the workspace: upload a table (built-in, CSV, GeoJSON /
// Esri JSON, ArcGIS URL) — the server stores it as a new table and returns
// its id — or pick one already in the database, or (signed in) one in the
// cloud: yours or shared with you, added as this device's copy linked to it. How its rows map to
// features is chosen per visualization.
import UiButton from '../ui/UiButton.vue'
import { computed, onMounted, ref } from 'vue'
import { request } from '../../client/api'
import { listDatasets } from '../../client/datasets'
import type { UploadSource } from '../../shared/api'
import { BUILTIN_TABLES, SAMPLE_TABLES } from '../../shared/builtins'
import { auth } from '../../client/auth'
import type { Access } from '../../shared/cloud'
import type { DatasetRecord } from '../../shared/records'

const props = defineProps<{
  inWorkspace: string[]
  /** Which source to show first. */
  start?: 'builtin' | 'sample' | 'csv' | 'json' | 'arcgis' | 'db' | 'cloud'
  /** The Saved list's button (Replace: "Use"). */
  pickLabel?: string
}>()
const emit = defineEmits<{ (e: 'add', datasetIds: string[]): void; (e: 'cancel'): void }>()

type Origin = 'builtin' | 'sample' | 'csv' | 'json' | 'arcgis' | 'db' | 'cloud'
const origin = ref<Origin>(props.start ?? 'builtin')
const builtin = ref(BUILTIN_TABLES[0].table)
const sample = ref(SAMPLE_TABLES[0]?.table ?? '')
const arcgisUrl = ref('')
const name = ref('')
/** Upload is one source with three kinds: CSV files, GeoJSON / Esri JSON files, an ArcGIS layer's URL. */
/** Library: datasets you already have, on this device or in your account, that aren't in this workspace. */
const inLibrary = computed(() => origin.value === 'db' || origin.value === 'cloud')
const uploading = computed(() => origin.value === 'csv' || origin.value === 'json' || origin.value === 'arcgis')
const busy = ref(false)
const error = ref('')

async function upload(source: UploadSource) {
  busy.value = true
  error.value = ''
  const r = await request('uploadDataset', { source, name: name.value.trim() || undefined })
  busy.value = false
  if (r.ok) emit('add', [r.data.datasetId])
  else error.value = r.error.message
}

/** Several files: each its own dataset, one at a time (so the phone parses one file at once). */
const progress = ref('')
const results = ref<{ file: string; ok: boolean; message: string; id?: string }[]>([])
async function uploadFiles(files: File[], kind: 'csv' | 'json') {
  if (files.length === 1) return upload({ kind, file: files[0] })
  busy.value = true
  error.value = ''
  results.value = []
  for (const [i, file] of files.entries()) {
    progress.value = `Uploading ${i + 1} of ${files.length}: ${file.name}…`
    const r = await request('uploadDataset', { source: { kind, file } })
    results.value.push(r.ok ? { file: file.name, ok: true, message: 'added', id: r.data.datasetId } : { file: file.name, ok: false, message: r.error.message })
  }
  busy.value = false
  progress.value = ''
  const added = results.value.flatMap((x) => (x.id ? [x.id] : []))
  // All went in: done. Otherwise the list stays up (what failed, and why) until Done.
  if (added.length === files.length) emit('add', added)
}
const addedIds = computed(() => results.value.flatMap((x) => (x.id ? [x.id] : [])))
function onFile(e: Event, kind: 'csv' | 'json') {
  const files = [...((e.target as HTMLInputElement).files ?? [])]
  ;(e.target as HTMLInputElement).value = ''
  if (files.length) uploadFiles(files, kind)
}

// ── already in the database ────────────────────────────────────────────────

const stored = ref<DatasetRecord[]>([])
const available = computed(() => stored.value.filter((d) => !props.inWorkspace.includes(d.id)))
async function refresh() {
  try {
    stored.value = (await listDatasets()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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

// ── in the cloud ───────────────────────────────────────────────────────────

type CloudItem = { cloudId: string; name: string; description: string; rows: number; access: Access; updatedAt: string; localId?: string }
const inCloud = ref<CloudItem[] | null>(null)
/** Not in this workspace already (by its copy here). */
const cloudAvailable = computed(() => (inCloud.value ?? []).filter((d) => !d.localId || !props.inWorkspace.includes(d.localId)))
async function refreshCloud() {
  error.value = ''
  inCloud.value = null
  const r = await request('cloudDatasets', {})
  if (r.ok) inCloud.value = r.data.datasets
  else ((inCloud.value = []), (error.value = r.error.message))
}
async function addCloud(d: CloudItem) {
  busy.value = true
  error.value = ''
  progress.value = d.localId ? '' : `Pulling "${d.name}" (${d.rows.toLocaleString()} rows)…`
  const r = await request('addFromCloud', { cloudId: d.cloudId })
  busy.value = false
  progress.value = ''
  if (r.ok) emit('add', [r.data.datasetId])
  else error.value = r.error.message
}
const ACCESS: Record<Access, string> = { owner: 'yours', write: 'shared with you · can push', read: 'shared with you · can pull' }
if (origin.value === 'cloud') void refreshCloud()
</script>

<template>
  <div class="add">
    <div class="seg">
      <button data-testid="add.source.builtin" :class="{ on: origin === 'builtin' }" @click="origin = 'builtin'">Built-in</button>
      <button v-if="SAMPLE_TABLES.length" data-testid="add.source.sample" :class="{ on: origin === 'sample' }" @click="origin = 'sample'">Samples</button>
      <button data-testid="add.source.upload" :class="{ on: uploading }" @click="uploading || (origin = 'csv')">Upload</button>
      <button data-testid="add.source.library" :class="{ on: inLibrary }" @click="inLibrary || ((origin = 'db'), refresh())">Library</button>
    </div>
    <div v-if="inLibrary" class="kinds" role="radiogroup" aria-label="Where your datasets are">
      <label><input data-testid="add.source.db" type="radio" value="db" :checked="origin === 'db'" @change="(origin = 'db'), refresh()" /> On this device</label>
      <label v-if="auth.user"><input data-testid="add.source.cloud" type="radio" value="cloud" :checked="origin === 'cloud'" @change="(origin = 'cloud'), refreshCloud()" /> In your account (cloud)</label>
      <span v-else class="muted small">Sign in to add datasets from your account.</span>
    </div>
    <template v-if="origin === 'cloud'">
      <p v-if="!inCloud" class="muted small">Looking in the cloud…</p>
      <p v-else-if="!cloudAvailable.length && !error" class="muted small">
        {{ inCloud.length ? 'Every cloud dataset you can use is in this workspace.' : 'No cloud datasets yet: link one of yours (its menu → Link to cloud), or ask someone to share theirs with you.' }}
      </p>
      <ul class="stored">
        <li v-for="d in cloudAvailable" :key="d.cloudId">
          <span class="grow" :title="[d.name, d.description].filter(Boolean).join('\n')">
            <strong class="clip">{{ d.name }}</strong>
            <span class="muted small clip">{{ d.rows.toLocaleString() }} rows · {{ ACCESS[d.access] }}{{ d.localId ? ' · on this device' : '' }}</span>
          </span>
          <button class="btn primary" :disabled="busy" @click="addCloud(d)">{{ pickLabel ?? 'Add' }}</button>
        </li>
      </ul>
      <p v-if="progress" class="muted small clip">{{ progress }}</p>
    </template>
    <template v-else-if="origin !== 'db'">
      <div v-if="uploading" class="kinds" role="radiogroup" aria-label="What to upload">
        <label><input data-testid="add.source.csv" type="radio" value="csv" :checked="origin === 'csv'" @change="origin = 'csv'" /> CSV files</label>
        <label><input data-testid="add.source.json" type="radio" value="json" :checked="origin === 'json'" @change="origin = 'json'" /> GeoJSON / Esri JSON</label>
        <label><input data-testid="add.source.arcgis" type="radio" value="arcgis" :checked="origin === 'arcgis'" @change="origin = 'arcgis'" /> ArcGIS URL</label>
      </div>
      <label class="row">Name <input v-model="name" type="text" :placeholder="origin === 'csv' || origin === 'json' ? '(from the file; one file only)' : '(from the source)'" /></label>
      <div v-if="origin === 'builtin'" class="row">
        <select v-model="builtin">
          <option v-for="b in BUILTIN_TABLES" :key="b.table" :value="b.table">{{ b.label }}</option>
        </select>
        <button class="btn primary" :disabled="busy" @click="upload({ kind: 'builtin', table: builtin })">Add</button>
      </div>
      <div v-else-if="origin === 'sample'" class="row">
        <select v-model="sample" aria-label="Sample dataset">
          <option v-for="b in SAMPLE_TABLES" :key="b.table" :value="b.table">{{ b.label }}</option>
        </select>
        <button class="btn primary" :disabled="busy || !sample" @click="upload({ kind: 'builtin', table: sample })">Add</button>
      </div>
      <label v-else-if="origin === 'csv'" class="btn file">
        <input data-testid="add.csv-input" type="file" accept=".csv,text/csv" multiple :disabled="busy" @change="onFile($event, 'csv')" />
        Choose CSV files…
      </label>
      <label v-else-if="origin === 'json'" class="btn file">
        <input data-testid="add.json-input" type="file" accept=".json,.geojson,application/json,application/geo+json" multiple :disabled="busy" @change="onFile($event, 'json')" />
        Choose .geojson / Esri .json files…
      </label>
      <form v-else class="row" @submit.prevent="arcgisUrl.trim() && upload({ kind: 'arcgis', url: arcgisUrl.trim() })">
        <input v-model="arcgisUrl" data-testid="add.arcgis-url" type="url" placeholder="https://…/FeatureServer/0" autocapitalize="off" aria-label="ArcGIS layer URL" />
        <button class="btn primary" data-testid="add.arcgis-add" type="submit" :disabled="busy">Add</button>
      </form>
      <p class="muted small clip">{{ progress || (busy ? 'Uploading…' : 'Each file is stored as its own dataset, a new table in the database (on this device for now).') }}</p>
      <template v-if="results.length && !busy">
        <ul class="results">
          <li v-for="r in results" :key="r.file" :class="r.ok ? 'ok' : 'bad'">
            <span class="clip" :title="r.file">{{ r.ok ? '✓' : '⚠' }} {{ r.file }}</span>
            <span v-if="!r.ok" class="small">{{ r.message }}</span>
          </li>
        </ul>
        <div class="row end">
          <button class="btn primary" @click="emit('add', addedIds)">{{ addedIds.length ? `Add ${addedIds.length} to the workspace` : 'Done' }}</button>
        </div>
      </template>
    </template>
    <template v-else>
      <p v-if="!available.length" class="muted small">Every dataset on this device is already in this workspace.</p>
      <ul class="stored">
        <li v-for="d in available" :key="d.id">
          <span class="grow" :title="`${d.name}\n${d.origin}`">
            <strong class="clip">{{ d.name }}</strong>
            <span class="muted small clip">{{ d.rowCount.toLocaleString() }} rows · {{ d.origin }}</span>
          </span>
          <button class="btn primary" @click="emit('add', [d.id])">{{ pickLabel ?? 'Add' }}</button>
          <UiButton size="compact" tone="danger" icon="⊗" aria-label="Delete from the database" title="Delete from the database" @click="deleteStored(d)" />
        </li>
      </ul>
    </template>
    <p v-if="error" class="error small">{{ error }}</p>
    <button class="btn link" @click="emit('cancel')">Cancel</button>
  </div>
</template>

<style scoped>
.kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.9rem;
  font-size: 0.85rem;
}
.kinds label {
  display: inline-flex;
  gap: 0.3rem;
  align-items: center;
}
.add {
  display: grid;
  /* One column that can shrink: a long dataset or file name never widens the page. */
  grid-template-columns: minmax(0, 1fr);
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
  grid-template-columns: minmax(0, 1fr);
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
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}
/* Long names end in … (the full text is on hover / long-press via title). */
.clip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.2rem;
}
.results li {
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

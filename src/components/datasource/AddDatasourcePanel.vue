<script setup lang="ts">
// Import a data source: pick where the rows come from (a connector), say
// which column(s) hold each row's feature, and optionally combine two numeric
// columns into a vector column. Live match counts show whether the binding
// works before anything is added.
import { computed, ref, shallowRef, watch } from 'vue'
import { featureTable, LocalFileConnector, MemoryConnector, type DataRecord, type DataConnector } from '../../lib/data/connectors'
import { fetchArcGISLayer, importJSON } from '../../lib/arcgis'
import { inferColumns, isNumericColumn, type ColumnInfo } from '../../lib/datasource/columns'
import { withVectorColumn } from '../../lib/datasource/datasource'
import { BOUNDARIES, groupRows, guessBinding, type BoundaryFeature, type BoundaryId, type GeometryBinding } from '../../lib/datasource/binding'
import { loadBoundaries } from './boundaries'

export interface BuiltInTable {
  label: string
  connector: DataConnector
  table: string
}
export interface NewDatasource {
  name: string
  origin: string
  records: DataRecord[]
  columns: ColumnInfo[]
  binding: GeometryBinding
}

const props = defineProps<{ builtIns: BuiltInTable[] }>()
const emit = defineEmits<{ (e: 'add', v: NewDatasource): void; (e: 'cancel'): void }>()

type Origin = 'builtin' | 'csv' | 'json' | 'arcgis'
const origin = ref<Origin>('builtin')
const builtInIndex = ref(0)
const arcgisUrl = ref('')
const busy = ref(false)
const error = ref('')

const records = shallowRef<DataRecord[] | null>(null)
const columns = shallowRef<ColumnInfo[]>([])
const originLabel = ref('')
const name = ref('')
const binding = ref<GeometryBinding | null>(null)

async function loaded(rows: DataRecord[], label: string, defaultName: string) {
  if (!rows.length) throw new Error('That table has no rows')
  records.value = rows
  columns.value = inferColumns(rows)
  originLabel.value = label
  name.value = defaultName
  vectors.value = []
  binding.value = guessBinding(columns.value) ?? { kind: 'boundary', column: columns.value[0].name, boundary: 'us-counties' }
}

async function run(fn: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function loadBuiltIn() {
  const b = props.builtIns[builtInIndex.value]
  return run(async () => loaded(await b.connector.readTable(b.table), `Built-in · ${b.table}`, b.label))
}
function onCsv(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  return run(async () => loaded(await new LocalFileConnector([], { t: f }).readTable('t'), `Device · ${f.name}`, f.name.replace(/\.csv$/i, '')))
}
function onJson(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  return run(async () => {
    const layer = importJSON(JSON.parse(await f.text()), f.name.replace(/\.(geo)?json$/i, ''))
    const src = new MemoryConnector(f.name, { features: featureTable(layer.features) })
    await loaded(await src.readTable('features'), `Device · ${f.name}`, layer.name)
  })
}
function onArcgis() {
  if (!arcgisUrl.value.trim()) return
  return run(async () => {
    const layer = await fetchArcGISLayer(arcgisUrl.value.trim(), { maxFeatures: 5000 })
    await loaded(featureTable(layer.features), `ArcGIS · ${layer.name}`, layer.name)
  })
}

// ── binding preview ────────────────────────────────────────────────────────

const boundaries = shallowRef<Map<string, BoundaryFeature> | null>(null)
watch(
  () => (binding.value?.kind === 'boundary' ? binding.value.boundary : null),
  async (id) => {
    boundaries.value = null
    if (id) await run(async () => void (boundaries.value = await loadBoundaries(id as BoundaryId)))
  },
  { immediate: true },
)

const preview = computed(() => {
  const b = binding.value
  if (!records.value || !b) return null
  if (b.kind === 'boundary' && !boundaries.value) return null
  const r = groupRows(records.value, { ...b, ...(b.kind === 'boundary' ? { includeEmpty: false } : {}) }, boundaries.value ?? undefined)
  return { features: r.groups.length, matchedRows: records.value.length - r.unmatched, unmatched: r.unmatched, samples: r.unmatchedSamples }
})

function setKind(kind: GeometryBinding['kind']) {
  const first = columns.value[0]?.name ?? ''
  const guess = guessBinding(columns.value)
  if (guess?.kind === kind) binding.value = guess
  else if (kind === 'boundary') binding.value = { kind, column: first, boundary: 'us-counties' }
  else if (kind === 'latlon') binding.value = { kind, lat: first, lon: columns.value[1]?.name ?? first }
  else binding.value = { kind, column: first }
}

// ── vectors from two columns ───────────────────────────────────────────────

const numeric = computed(() => columns.value.filter((c) => isNumericColumn(c.type)))
const vectors = ref<{ name: string; u: string; v: string }[]>([])
function addVector() {
  const [u, v] = [numeric.value[0]?.name ?? '', numeric.value[1]?.name ?? numeric.value[0]?.name ?? '']
  vectors.value.push({ name: `vector_${vectors.value.length + 1}`, u, v })
}

function add() {
  if (!records.value || !binding.value || !preview.value?.features) return
  let rows = records.value
  const cols = [...columns.value]
  for (const vec of vectors.value) {
    const n = vec.name.trim()
    if (!n || !vec.u || !vec.v || cols.some((c) => c.name === n)) continue
    rows = withVectorColumn(rows, n, vec.u, vec.v)
    cols.push({ name: n, type: 'vector' })
  }
  emit('add', { name: name.value.trim() || originLabel.value, origin: originLabel.value, records: rows, columns: cols, binding: binding.value })
}
</script>

<template>
  <div class="add">
    <template v-if="!records">
      <div class="seg">
        <button :class="{ on: origin === 'builtin' }" @click="origin = 'builtin'">Built-in</button>
        <button :class="{ on: origin === 'csv' }" @click="origin = 'csv'">CSV file</button>
        <button :class="{ on: origin === 'json' }" @click="origin = 'json'">GeoJSON / Esri</button>
        <button :class="{ on: origin === 'arcgis' }" @click="origin = 'arcgis'">ArcGIS URL</button>
      </div>
      <div v-if="origin === 'builtin'" class="row">
        <select v-model="builtInIndex">
          <option v-for="(b, i) in builtIns" :key="b.table" :value="i">{{ b.label }}</option>
        </select>
        <button class="btn" :disabled="busy" @click="loadBuiltIn">Load</button>
      </div>
      <label v-else-if="origin === 'csv'" class="btn file">
        <input type="file" accept=".csv,text/csv" @change="onCsv" />
        Choose a CSV…
      </label>
      <label v-else-if="origin === 'json'" class="btn file">
        <input type="file" accept=".json,.geojson,application/json,application/geo+json" @change="onJson" />
        Choose a .geojson / Esri .json…
      </label>
      <form v-else class="row" @submit.prevent="onArcgis">
        <input v-model="arcgisUrl" type="url" placeholder="https://…/FeatureServer/0" autocapitalize="off" />
        <button class="btn" type="submit" :disabled="busy">Load</button>
      </form>
      <p class="muted small">Files stay on your device.</p>
    </template>

    <template v-else-if="binding">
      <p class="muted small">{{ originLabel }} · {{ records.length.toLocaleString() }} rows · {{ columns.length }} columns</p>
      <label class="row">Name <input v-model="name" type="text" /></label>

      <div class="lbl">Each row's feature comes from</div>
      <div class="seg">
        <button :class="{ on: binding.kind === 'boundary' }" @click="setKind('boundary')">Region code</button>
        <button :class="{ on: binding.kind === 'latlon' }" @click="setKind('latlon')">Lat / lon</button>
        <button :class="{ on: binding.kind === 'geometry' }" @click="setKind('geometry')">Geometry column</button>
      </div>
      <template v-if="binding.kind === 'boundary'">
        <label class="row">
          Code column
          <select v-model="binding.column">
            <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </label>
        <label class="row">
          Regions
          <select v-model="binding.boundary">
            <option v-for="(label, id) in BOUNDARIES" :key="id" :value="id">{{ label }}</option>
          </select>
        </label>
        <label class="check"><input v-model="binding.includeEmpty" type="checkbox" /> Also show regions with no rows</label>
      </template>
      <template v-else-if="binding.kind === 'latlon'">
        <label class="row">
          Latitude
          <select v-model="binding.lat">
            <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </label>
        <label class="row">
          Longitude
          <select v-model="binding.lon">
            <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </label>
      </template>
      <label v-else class="row">
        GeoJSON / WKT column
        <select v-model="binding.column">
          <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>

      <div v-if="numeric.length" class="vectors">
        <div class="lbl">Vector columns <span class="muted small">(drawn as arrows)</span></div>
        <p v-if="columns.some((c) => c.type === 'vector')" class="muted small">
          Detected: {{ columns.filter((c) => c.type === 'vector').map((c) => c.name).join(', ') }}
        </p>
        <div v-for="(vec, i) in vectors" :key="i" class="vec">
          <input v-model="vec.name" type="text" aria-label="Vector column name" />
          <select v-model="vec.u" aria-label="East component">
            <option v-for="c in numeric" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
          <select v-model="vec.v" aria-label="North component">
            <option v-for="c in numeric" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
          <button class="icon" aria-label="Remove" @click="vectors.splice(i, 1)">✕</button>
        </div>
        <p v-if="vectors.length" class="muted small">name · east (u) column · north (v) column</p>
        <button class="btn link add-vec" @click="addVector">＋ Combine two columns into a vector</button>
      </div>

      <p v-if="preview" class="small" :class="preview.features ? 'ok' : 'bad'">
        {{ preview.features.toLocaleString() }} features from {{ preview.matchedRows.toLocaleString() }} rows
        <template v-if="preview.unmatched">
          · {{ preview.unmatched.toLocaleString() }} rows unmatched (e.g. {{ preview.samples.slice(0, 3).join(', ') }})
        </template>
      </p>
      <p v-else class="muted small">Checking…</p>

      <div class="row end">
        <button class="btn" @click="records = null">Back</button>
        <button class="btn primary" :disabled="!preview?.features" @click="add">Import</button>
      </div>
    </template>

    <p v-if="error" class="error small">{{ error }}</p>
    <button v-if="!records" class="btn link" @click="emit('cancel')">Cancel</button>
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
  color: #fff;
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
  color: #fff;
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
.muted {
  color: var(--text-muted);
}
.small {
  font-size: 0.75rem;
  margin: 0;
}
.ok {
  color: #2e7d32;
}
.bad,
.error {
  color: var(--danger);
}
</style>

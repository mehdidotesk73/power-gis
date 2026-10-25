<script setup lang="ts">
// The map page. Users import datasets (a table + where its features are)
// and add visualizations of their columns; one ordered list of
// visualizations, from any mix of datasets, shows together (top draws on
// top). The EIA-861 utilities dataset is preloaded with its own dashboard
// and utility search.
import { computed, markRaw, nextTick, onMounted, ref, shallowRef, watch } from 'vue'
import MapView from './map/MapView.vue'
import ScalarLayer from './map/ScalarLayer'
import VectorLayer from './map/VectorLayer'
import MapLegend from './map/MapLegend.vue'
import FeatureTooltip from './map/FeatureTooltip.vue'
import FeaturePanel from './map/FeaturePanel.vue'
import DataExchange from './map/DataExchange.vue'
import SearchBox from './map/SearchBox.vue'
import AddDatasetPanel, { type BuiltInTable, type NewDataset } from './dataset/AddDatasetPanel.vue'
import DatasetList from './dataset/DatasetList.vue'
import VisualizationList from './dataset/VisualizationList.vue'
import FeatureRows from './dataset/FeatureRows.vue'
import UtilityCountyDashboard from './UtilityCountyDashboard.vue'
import type { LoadedDataset } from './dataset/types'
import type { HoverInfo } from './map/mapContext'
import { loadBoundaries } from './dataset/boundaries'
import { UTILITY_BINDING, UTILITY_NAME, UTILITY_TABLE, utilityVisualizations, withOwnershipFlags } from './utilityStyles'
import { utilitiesFromRows, utilityRowsFromRecords, type Utility } from '../lib/utilities'
import { MemoryConnector, StaticFileConnector, type DataRecord } from '../lib/data/connectors'
import { inferColumns, type ColumnInfo } from '../lib/dataset/columns'
import { buildDataset, newId, ROW_COUNT, withVectorColumn, type BuiltDataset } from '../lib/dataset/dataset'
import {
  addDataset,
  addVisualization as addVisualization_,
  emptyWorkspace,
  newDatasetMeta,
  removeDataset as removeDataset_,
  removeVisualization as removeVisualization_,
  reorderDatasets as reorderDatasets_,
  reorderVisualizations as reorderVisualizations_,
  updateDataset as updateDataset_,
  updateVisualization as updateVisualization_,
  type DatasetEntry,
  type OpContext,
  type OpResult,
  type WorkspaceDoc,
} from '../lib/workspace/workspace'
import { loadWorkspace, saveWorkspace } from '../lib/workspace/storage'
import { indexedDbTableStore, localKeyValueStore } from './workspace/browserStores'
import { defaultVisualization, visualizationData, makeVisualization, ROWS, VALUE, type VisualizationSpec } from '../lib/dataset/visualization'
import { demoVectorRows } from '../lib/demo'
import { focusBox } from '../lib/geometry'
import { colorLegend, MAGNITUDE_FIELD, patternLegend, vectorOf, type LegendEntry } from '../lib/style'
import { fieldLabel, type LayerData, type LayerFeature } from '../lib/schema'
import { formatPrimitive } from '../lib/format'
import { logDebug } from '../debug'

const base = import.meta.env.BASE_URL
const mapView = ref<InstanceType<typeof MapView>>()
const vizList = ref<{ edit: (id: string) => void }>()
const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorMsg = ref('')

const builtIn = new StaticFileConnector([UTILITY_TABLE, 'utilities'], base)
const demo = new MemoryConnector('Demo', { demo_vectors: demoVectorRows() })
const builtIns: BuiltInTable[] = [
  { label: 'EIA-861 utilities by county', connector: builtIn, table: UTILITY_TABLE },
  { label: 'EIA-861 utility list (no geometry)', connector: builtIn, table: 'utilities' },
  { label: 'Demo vector field (synthetic)', connector: demo, table: 'demo_vectors' },
]

// ── workspace: datasets and visualizations ─────────────────────────────────
// The workspace document is the single source of truth and is saved on the
// device; every change goes through an operation in lib/workspace. Built
// datasets (features + rows) are kept beside it, by dataset id.

const doc = shallowRef<WorkspaceDoc>(emptyWorkspace())
const builts = shallowRef(new Map<string, BuiltDataset>())
const importing = ref(false)
const utilities = shallowRef<Utility[]>([])
const tables = indexedDbTableStore
let persist = false
let warnedSave = false

const datasets = computed<LoadedDataset[]>(() =>
  doc.value.datasets.flatMap((e) => {
    const built = builts.value.get(e.id)
    return built ? [{ spec: { id: e.id, name: e.name, binding: e.binding, origin: e.origin }, built, meta: e.meta, preset: e.preset }] : []
  }),
)
const visualizations = computed(() => doc.value.visualizations)
const dsById = computed(() => new Map(datasets.value.map((d) => [d.spec.id, d])))
const opCtx: OpContext = { columns: (id) => builts.value.get(id)?.columns.map((c) => c.name) }

/** Applies an operation's result; failures are logged, not thrown. */
function apply(r: OpResult): boolean {
  if (!r.ok) {
    logDebug(`workspace: ${r.error.message}`, 'warn')
    return false
  }
  doc.value = r.doc
  return true
}

watch(doc, (d) => {
  if (!persist || saveWorkspace(localKeyValueStore, d) || warnedSave) return
  warnedSave = true
  logDebug('workspace could not be saved on this device (private browsing or storage full?)', 'warn')
})

/** A dataset's rows: built-in tables are re-read, imported ones come from device storage. */
async function rowsFor(e: DatasetEntry): Promise<DataRecord[]> {
  if (e.rows.kind === 'stored') {
    const rows = await tables.get(e.id)
    if (!rows) throw new Error('its rows are no longer stored on this device')
    return rows
  }
  const table = e.rows.table
  const t = builtIns.find((b) => b.table === table)
  if (!t) throw new Error(`no built-in table "${table}"`)
  let rows = await t.connector.readTable(table)
  if (e.preset === 'utilities') rows = withOwnershipFlags(rows)
  for (const v of e.vectorColumns ?? []) rows = withVectorColumn(rows, v.name, v.u, v.v)
  return rows
}

async function build(e: DatasetEntry, records: DataRecord[], columns: ColumnInfo[]): Promise<BuiltDataset> {
  const boundaries = e.binding.kind === 'boundary' ? await loadBoundaries(e.binding.boundary) : undefined
  const built = markRaw(buildDataset({ id: e.id, name: e.name, binding: e.binding, origin: e.origin }, records, columns, boundaries))
  if (built.unmatched) logDebug(`${e.name}: ${built.unmatched} rows had no feature (e.g. ${built.unmatchedSamples.slice(0, 5).join(', ')})`, 'warn')
  builts.value = new Map(builts.value).set(e.id, built)
  if (e.preset === 'utilities') utilities.value = utilitiesFromRows(utilityRowsFromRecords(records))
  return built
}

async function onImport(n: NewDataset) {
  importing.value = false
  const entry: DatasetEntry = {
    id: newId('ds'),
    name: n.name,
    binding: n.binding,
    origin: n.origin,
    rows: n.builtinTable ? { kind: 'builtin', table: n.builtinTable } : { kind: 'stored' },
    ...(n.vectorColumns.length ? { vectorColumns: n.vectorColumns } : {}),
    meta: newDatasetMeta(),
  }
  try {
    const built = await build(entry, n.records, n.columns)
    if (!apply(addDataset(doc.value, entry, [defaultVisualization(built, entry.id)]))) return
    logDebug(`imported "${n.name}": ${built.base.features.length} features from ${n.records.length} rows`)
    zoomTo(entry.id)
    if (entry.rows.kind === 'stored') {
      await tables.put(entry.id, n.records).catch((e: Error) => logDebug(`"${n.name}" couldn't be saved on this device, so it won't survive a reload: ${e.message}`, 'warn'))
    }
  } catch (e) {
    logDebug(`could not import "${n.name}": ${(e as Error).message}`, 'error')
  }
}

function removeDataset(id: string) {
  if (!apply(removeDataset_(doc.value, id))) return
  const next = new Map(builts.value)
  next.delete(id)
  builts.value = next
  tables.delete(id).catch(() => {})
  if (selected.value?.datasetId === id) selected.value = null
}

/** New visualization of a dataset column, on top of the list, open for editing. */
function addVisualization(datasetId: string, column: string) {
  const ds = dsById.value.get(datasetId)
  if (!ds) return
  const v = makeVisualization(ds.built, datasetId, column)
  if (apply(addVisualization_(doc.value, v, 0, opCtx))) vizList.value?.edit(v.id)
}

const updateVisualization = (v: VisualizationSpec) => apply(updateVisualization_(doc.value, v, opCtx))
const removeVisualization = (id: string) => apply(removeVisualization_(doc.value, id))
const reorderVisualizations = (ids: string[]) => apply(reorderVisualizations_(doc.value, ids))
const reorderDatasets = (ids: string[]) => apply(reorderDatasets_(doc.value, ids))
const updateDataset = (id: string, patch: { name?: string; description?: string }) => apply(updateDataset_(doc.value, id, patch))

function zoomTo(id: string) {
  const ds = dsById.value.get(id)
  const b = ds && focusBox(ds.built.base.features.filter((f) => (f.properties[ROW_COUNT] as number) > 0).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b, 10)
}

/** The starting workspace: the EIA-861 utilities dataset with its preset visualizations. */
async function seedDefault() {
  const entry: DatasetEntry = {
    id: newId('ds'),
    name: UTILITY_NAME,
    binding: UTILITY_BINDING,
    origin: 'Built-in · utility_counties.csv (EIA-861, 2025)',
    rows: { kind: 'builtin', table: UTILITY_TABLE },
    preset: 'utilities',
    meta: newDatasetMeta('Every US electric utility and the counties it serves (EIA Form 861 Service Territory, 2025).'),
  }
  const records = await rowsFor(entry)
  await build(entry, records, inferColumns(records))
  apply(addDataset(emptyWorkspace(), entry, utilityVisualizations(entry.id)))
}

/** Reopens the saved workspace; datasets that can't be rebuilt are dropped (and logged). */
async function restore(saved: WorkspaceDoc) {
  doc.value = saved
  const failed: string[] = []
  await Promise.all(
    saved.datasets.map(async (e) => {
      try {
        const rows = await rowsFor(e)
        await build(e, rows, inferColumns(rows))
      } catch (err) {
        failed.push(e.id)
        logDebug(`couldn't reopen dataset "${e.name}": ${(err as Error).message}`, 'warn')
      }
    }),
  )
  for (const id of failed) apply(removeDataset_(doc.value, id))
  logDebug(`workspace reopened: ${doc.value.datasets.length} datasets, ${doc.value.visualizations.length} visualizations`)
}

async function resetWorkspace() {
  if (!confirm('Reset the workspace? This removes every imported dataset and visualization from this device.')) return
  persist = false
  selected.value = null
  clearUtility()
  await tables.clear().catch(() => {})
  builts.value = new Map()
  doc.value = emptyWorkspace()
  await seedDefault()
  persist = true
  saveWorkspace(localKeyValueStore, doc.value)
}

onMounted(async () => {
  try {
    const saved = loadWorkspace(localKeyValueStore)
    if (saved) await restore(saved)
    else await seedDefault()
    persist = true
    saveWorkspace(localKeyValueStore, doc.value)
    status.value = 'ready'
  } catch (e) {
    status.value = 'error'
    errorMsg.value = (e as Error).message
    logDebug(`load failed: ${errorMsg.value}`, 'error')
  }
})

// ── visualization data (cached: restyling must not rebuild or re-upload data)

interface CacheEntry {
  sig: string
  built: BuiltDataset
  data: LayerData
  byKey: Map<string, LayerFeature>
}
const cache = new Map<string, CacheEntry>()

function entryFor(l: VisualizationSpec): CacheEntry | null {
  const ds = dsById.value.get(l.datasetId)
  if (!ds) return null
  const sig = `${l.column}|${l.aggregation}|${ds.spec.name}|${l.name}`
  const hit = cache.get(l.id)
  if (hit && hit.sig === sig && hit.built === ds.built) return hit
  const data = markRaw(visualizationData(ds.built, ds.spec.name, l))
  const entry = { sig, built: ds.built, data, byKey: new Map(data.features.map((f) => [String(f.id), f])) }
  cache.set(l.id, entry)
  return entry
}
const dataFor = (l: VisualizationSpec) => entryFor(l)?.data ?? null

const rendered = computed(() =>
  visualizations.value.flatMap((l) => {
    const e = entryFor(l)
    const ds = dsById.value.get(l.datasetId)
    return e && ds ? [{ layer: l, ds, data: e.data }] : []
  }),
)
const renderedById = computed(() => new Map(rendered.value.map((r) => [r.layer.id, r])))

// Keep the map's stacking in step with the list (top of the list draws on top).
watch(
  () => rendered.value.map((r) => r.layer.id).join('|'),
  () => nextTick(() => mapView.value?.restack(rendered.value.map((r) => r.layer.id))),
  { flush: 'post' },
)

// ── hover / select ─────────────────────────────────────────────────────────

const canHover = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches
const hover = ref<HoverInfo | null>(null)
const selected = ref<{ datasetId: string; key: string } | null>(null)

function onHover(layerId: string, h: HoverInfo | null) {
  if (!canHover) return
  hover.value = h ? { ...h, layerId } : hover.value?.layerId === layerId ? null : hover.value
}
function onSelect(layerId: string, key: string) {
  const r = renderedById.value.get(layerId)
  if (r) selected.value = { datasetId: r.ds.spec.id, key }
  hover.value = null
}

/** A visualization's value on a feature, as display text. */
function displayValue(l: VisualizationSpec, key: string): string {
  const e = entryFor(l)
  const p = e?.byKey.get(key)?.properties
  return p ? formatPrimitive(p[VALUE], e!.data.fields[0].type) : '—'
}

/** Visualizations of a dataset (optionally only the visible ones). */
const vizOf = (dsId: string, visibleOnly = false) => visualizations.value.filter((l) => l.datasetId === dsId && (!visibleOnly || l.visible))

const hoverCard = computed(() => {
  const h = hover.value
  const r = h && renderedById.value.get(h.layerId)
  if (!h || !r) return null
  const f = entryFor(r.layer)?.byKey.get(h.featureId)
  if (!f) return null
  return {
    x: h.x,
    y: h.y,
    title: String(f.properties._label),
    rows: [
      ...vizOf(r.ds.spec.id, true).map((l) => ({ label: l.name, value: displayValue(l, h.featureId) })),
      { label: 'Rows', value: String(f.properties[ROW_COUNT]) },
    ],
  }
})

const selectedFeature = computed(() => {
  const s = selected.value
  const ds = s && dsById.value.get(s.datasetId)
  const feature = ds?.built.base.features.find((f) => f.id === s!.key)
  return ds && feature ? { ds, feature, key: s!.key, rows: ds.built.rowsByKey.get(s!.key) ?? [] } : null
})
const selectedKeyFor = (dsId: string) => (selected.value?.datasetId === dsId ? selected.value.key : null)

// ── utility search (preset extra) ──────────────────────────────────────────

const searchBox = ref<{ clear: () => void }>()
const selectedUtility = ref<Utility | null>(null)
const utilityDs = computed(() => datasets.value.find((d) => d.preset === 'utilities'))
const utilityName = (u: Utility) => u.utility_name
const utilityDetail = (u: Utility) => `${u.entity_type} · ${u.states.join(', ')} · ${u.county_fips.length} counties`
function pickUtility(id: number) {
  const u = utilities.value.find((x) => x.utility_id_eia === id) ?? null
  selectedUtility.value = u
  const ds = utilityDs.value
  if (!u || !ds) return
  const keys = new Set(u.county_fips)
  const b = focusBox(ds.built.base.features.filter((f) => keys.has(String(f.id))).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b)
}
function clearUtility() {
  selectedUtility.value = null
  searchBox.value?.clear()
}
const highlightFor = (ds: LoadedDataset) => (ds.preset === 'utilities' ? (selectedUtility.value?.county_fips ?? []) : [])

// ── legend ─────────────────────────────────────────────────────────────────

const legend = computed<LegendEntry[]>(() => {
  const out: LegendEntry[] = []
  const shown = rendered.value.filter((r) => r.layer.visible)
  const many = new Set(shown.map((r) => r.ds.spec.id)).size > 1
  for (const { layer: l, ds, data } of shown) {
    const title = many ? `${ds.spec.name}: ${l.name}` : l.name
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

// ── export ─────────────────────────────────────────────────────────────────

const exportTarget = ref<string | null>(null)
const exportLayer = computed(() => (dsById.value.get(exportTarget.value ?? '') ?? datasets.value[0])?.built.base ?? null)
</script>

<template>
  <div class="page">
    <section class="controls">
      <div v-if="utilityDs" class="search">
        <SearchBox
          ref="searchBox"
          label="Find a utility"
          placeholder="e.g. Duke Energy Carolinas"
          :items="utilities"
          :text="utilityName"
          :detail="utilityDetail"
          @pick="(u) => pickUtility(u.utility_id_eia)"
        />
        <div v-if="selectedUtility" class="chip">
          <div>
            <strong>{{ selectedUtility.utility_name }}</strong>
            <div class="muted">
              {{ selectedUtility.entity_type }} · {{ selectedUtility.county_fips.length }} counties ·
              {{ formatPrimitive(selectedUtility.customers, 'int') }} customers
            </div>
          </div>
          <button aria-label="Clear utility" @click="clearUtility">✕</button>
        </div>
      </div>

      <details class="box" open>
        <summary>Visualizations</summary>
        <VisualizationList
          ref="vizList"
          :visualizations="visualizations"
          :datasets="datasets"
          :data-for="dataFor"
          @add="addVisualization"
          @update="updateVisualization"
          @remove="removeVisualization"
          @reorder="reorderVisualizations"
        />
      </details>

      <details class="box" open>
        <summary>Datasets</summary>
        <DatasetList
          :datasets="datasets"
          :viz-count="(id) => vizOf(id).length"
          @zoom="zoomTo"
          @remove="removeDataset"
          @reorder="reorderDatasets"
          @update="updateDataset"
        />
        <div class="import-wrap">
          <AddDatasetPanel v-if="importing" :built-ins="builtIns" @add="onImport" @cancel="importing = false" />
          <button v-else class="import-btn" @click="importing = true">＋ Import dataset</button>
        </div>
        <p class="muted small saved">
          Saved on this device ·
          <button class="link" @click="resetWorkspace">Reset workspace</button>
        </p>
      </details>

      <details class="box">
        <summary>Export (ArcGIS)</summary>
        <label class="row">
          Dataset
          <select :value="exportTarget ?? datasets[0]?.spec.id" @change="exportTarget = ($event.target as HTMLSelectElement).value">
            <option v-for="d in datasets" :key="d.spec.id" :value="d.spec.id">{{ d.spec.name }}</option>
          </select>
        </label>
        <DataExchange :layer="exportLayer" />
        <p class="muted small">
          Source CSVs:
          <a :href="`${base}data/utility_counties.csv`" download>utility_counties.csv</a> ·
          <a :href="`${base}data/utilities.csv`" download>utilities.csv</a>
        </p>
      </details>
    </section>

    <section class="map-wrap">
      <MapView ref="mapView" @background-click="selected = null">
        <template v-for="r in rendered" :key="`${r.layer.id}-${r.layer.kind}`">
          <ScalarLayer
            v-if="r.layer.kind === 'scalar'"
            :layer="r.data"
            :style-spec="r.layer.style"
            :visible="r.layer.visible"
            :highlight-ids="highlightFor(r.ds)"
            :selected-id="selectedKeyFor(r.ds.spec.id)"
            @hover="(h) => onHover(r.layer.id, h)"
            @select="(id) => onSelect(r.layer.id, id)"
          />
          <VectorLayer
            v-else
            :layer="r.data"
            :style-spec="r.layer.style"
            :visible="r.layer.visible"
            @hover="(h) => onHover(r.layer.id, h)"
            @select="(id) => onSelect(r.layer.id, id)"
          />
        </template>
        <template #overlay>
          <div v-if="status !== 'ready'" class="status" :class="status">
            {{ status === 'loading' ? 'Loading data…' : `Couldn't load data: ${errorMsg}` }}
          </div>
          <MapLegend :entries="legend" />
          <FeatureTooltip v-if="hoverCard && !selectedFeature" v-bind="hoverCard" />
          <FeaturePanel v-if="selectedFeature" :layer="selectedFeature.ds.built.base" :feature="selectedFeature.feature" @close="selected = null">
            <dl class="values">
              <template v-for="l in vizOf(selectedFeature.ds.spec.id)" :key="l.id">
                <dt>{{ l.name }}</dt>
                <dd>{{ displayValue(l, selectedFeature.key) }}</dd>
              </template>
            </dl>
            <UtilityCountyDashboard
              v-if="selectedFeature.ds.preset === 'utilities'"
              :rows="selectedFeature.rows"
              :selected-utility-id="selectedUtility?.utility_id_eia ?? null"
              @pick-utility="pickUtility"
            />
            <FeatureRows v-else :built="selectedFeature.ds.built" :rows="selectedFeature.rows" />
          </FeaturePanel>
        </template>
      </MapView>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: 21rem 1fr;
  gap: 0.75rem;
  height: calc(100dvh - 9rem);
  min-height: 32rem;
}
.controls {
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  font-size: 0.85rem;
  padding-right: 0.15rem;
}
.map-wrap {
  min-height: 0;
}
.chip {
  margin-top: 0.4rem;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--accent-blue);
  border-radius: 0.4rem;
}
.chip button {
  background: none;
  border: none;
  color: var(--text-muted);
}
.box {
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  padding: 0.45rem 0.6rem;
}
.box summary {
  font-weight: 600;
  cursor: pointer;
}
.box[open] summary {
  margin-bottom: 0.45rem;
}
.import-wrap {
  margin-top: 0.6rem;
}
.import-btn {
  width: 100%;
  padding: 0.45rem;
  border: 1px dashed var(--accent-blue);
  border-radius: 0.4rem;
  background: none;
  color: var(--accent-blue);
  font-size: 0.85rem;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}
.row select {
  max-width: 13rem;
  padding: 0.25rem;
}
.muted {
  color: var(--text-muted);
  font-size: 0.78rem;
}
.small {
  font-size: 0.72rem;
}
.saved {
  margin: 0.5rem 0 0;
}
.link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent-blue);
  font-size: inherit;
  text-decoration: underline;
}
.values {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 0.6rem;
  margin: 0;
  font-size: 0.82rem;
}
.values dt {
  color: var(--text-muted);
}
.values dd {
  margin: 0;
  font-weight: 600;
}
.status {
  position: absolute;
  z-index: 3;
  top: 0.6rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0.35rem 0.7rem;
  font-size: 0.8rem;
}
.status.error {
  color: var(--danger);
  border-color: var(--danger);
}
@media (max-width: 48rem) {
  .page {
    grid-template-columns: 1fr;
    grid-template-rows: 70dvh auto;
    height: auto;
  }
  .controls {
    order: 2;
    overflow: visible;
  }
  .map-wrap {
    order: 1;
    height: 70dvh;
  }
}
</style>

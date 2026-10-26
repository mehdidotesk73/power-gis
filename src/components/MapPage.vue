<script setup lang="ts">
// The map page — a client. It holds the working copy of a workspace
// (dataset pointers + ordered visualizations), reads registry records and
// rows from the database (read-only), and asks the server for everything
// lasting or heavy: uploads, dataset edits, each visualization's values,
// the rows behind a feature, and saving the workspace (on Save; until then
// edits are a draft kept on the device). Top of the
// visualization list draws on top. The EIA-861 utilities dataset is the
// starting workspace, with its own dashboard and utility search.
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue'
import MapView from './map/MapView.vue'
import ScalarLayer from './map/ScalarLayer'
import VectorLayer from './map/VectorLayer'
import MapLegend from './map/MapLegend.vue'
import FeatureTooltip from './map/FeatureTooltip.vue'
import FeaturePanel from './map/FeaturePanel.vue'
import DataExchange from './map/DataExchange.vue'
import SearchBox from './map/SearchBox.vue'
import AddDatasetPanel from './dataset/AddDatasetPanel.vue'
import DatasetList from './dataset/DatasetList.vue'
import VisualizationList from './dataset/VisualizationList.vue'
import FeatureRows from './dataset/FeatureRows.vue'
import UtilityCountyDashboard from './UtilityCountyDashboard.vue'
import WorkspaceBar from './workspace/WorkspaceBar.vue'
import type { HoverInfo } from './map/mapContext'
import { describeBinding, forgetBindingInfo } from './dataset/useBindingInfo'
import { UTILITY_NAME, utilityVisualizations } from './utilityStyles'
import { request } from '../client/api'
import { readDb } from '../client/db'
import { UTILITY_TABLE } from '../shared/builtins'
import type { DatasetRecord, WorkspaceRecord } from '../shared/records'
import { utilitiesFromRows, utilityRowsFromRecords, type Utility } from '../lib/utilities'
import type { DataRecord } from '../lib/data/connectors'
import { guessBinding, isSupportedBinding, type GeometryBinding } from '../lib/dataset/binding'
import { loadBoundaries } from '../lib/dataset/boundaries'
import { ROW_COUNT } from '../lib/dataset/dataset'
import { defaultVisualization, makeVisualization, settingsOf, visualizationLayer, VALUE, type VisualizationSpec } from '../lib/dataset/visualization'
import {
  addDataset,
  addVisualization as addVisualization_,
  emptyWorkspace,
  removeDataset as removeDataset_,
  removeVisualization as removeVisualization_,
  renameWorkspace,
  reorderDatasets as reorderDatasets_,
  reorderVisualizations as reorderVisualizations_,
  updateVisualization as updateVisualization_,
  type OpContext,
  type OpResult,
  type WorkspaceDoc,
} from '../lib/workspace/workspace'
import { fileName, fromWorkspaceFile, parseDraft, parseWorkspaceFile, snapshot, toWorkspaceFile, type Draft } from '../lib/workspace/file'
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

// ── workspace ──────────────────────────────────────────────────────────────

const doc = shallowRef<WorkspaceDoc>(emptyWorkspace())
/** Registry records of the workspace's datasets, read from the database. */
const records = shallowRef(new Map<string, DatasetRecord>())
const importing = ref(false)
const utilities = shallowRef<Utility[]>([])

const datasets = computed(() => doc.value.datasetIds.flatMap((id) => records.value.get(id) ?? []))
const visualizations = computed(() => doc.value.visualizations)
const opCtx: OpContext = { columns: (id) => records.value.get(id)?.columns.map((c) => c.name) }
const presetOf = (id: string) => records.value.get(id)?.extensions?.preset

/** Applies an operation's result; failures are logged, not thrown. */
function apply(r: OpResult): boolean {
  if (!r.ok) {
    logDebug(`workspace: ${r.error.message}`, 'warn')
    return false
  }
  doc.value = r.doc
  return true
}

/** Runs a server request; logs and returns null on failure. */
async function call<T>(what: string, p: Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>): Promise<T | null> {
  const r = await p
  if (r.ok) return r.data
  logDebug(`${what}: ${r.error.message}`, 'error')
  return null
}

async function loadRecord(id: string): Promise<DatasetRecord | undefined> {
  const r = await readDb.get('datasets', id)
  if (r) {
    records.value = new Map(records.value).set(id, r)
    if (r.extensions?.preset === 'utilities') void loadUtilities(r)
  }
  return r
}
async function loadUtilities(r: DatasetRecord) {
  const rows = await readDb.readRows(r.table)
  if (rows) utilities.value = utilitiesFromRows(utilityRowsFromRecords(rows))
}

// Saving: edits are a draft until Save sends them to the server. The draft
// is kept on this device (localStorage) so a reload doesn't lose it.
const LAST_WORKSPACE = 'powergis.lastWorkspace'
const DRAFT = 'powergis.draft'
const loaded = ref(false)
const savedSnap = ref('')
const saving = ref(false)
const barMessage = ref('')
const dirty = computed(() => loaded.value && snapshot(doc.value) !== savedSnap.value)

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    } catch {
      /* per-device convenience only */
    }
  },
}
watch([doc, savedSnap], () => {
  if (!loaded.value) return
  store.set(DRAFT, dirty.value ? JSON.stringify({ doc: doc.value, saved: savedSnap.value } satisfies Draft) : null)
})

async function save() {
  if (saving.value) return
  saving.value = true
  barMessage.value = ''
  const d = doc.value
  const r = await call(
    'save workspace',
    request('saveWorkspace', {
      id: d.id,
      name: d.name,
      config: { datasetIds: d.datasetIds },
      visualizations: d.visualizations.map((v) => ({ id: v.id, name: v.name, datasetId: v.datasetId, settings: settingsOf(v) })),
    }),
  )
  saving.value = false
  if (!r) return void (barMessage.value = 'Save failed — see View logs. Your changes are kept as a draft.')
  savedSnap.value = snapshot(d)
  if (!doc.value.id) doc.value = { ...doc.value, id: r.workspaceId }
  store.set(LAST_WORKSPACE, r.workspaceId)
}

/** Back to the workspace as last saved. */
async function revert() {
  const w = doc.value.id ? await readDb.get('workspaces', doc.value.id) : undefined
  if (!w) return
  resetSelection()
  await open(w)
  savedSnap.value = snapshot(doc.value)
  barMessage.value = ''
}

function resetSelection() {
  selected.value = null
  clearUtility()
}

const rename = (name: string) => apply(renameWorkspace(doc.value, name))

function download() {
  const blob = new Blob([JSON.stringify(toWorkspaceFile(doc.value), null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fileName(doc.value)
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

async function loadFile(f: File) {
  const parsed = parseWorkspaceFile(await f.text())
  if (!parsed.ok) return void (barMessage.value = parsed.error)
  if (dirty.value && !confirm('Replace your unsaved changes with the workspace from this file?')) return
  for (const id of parsed.file.datasetIds) await loadRecord(id)
  const { doc: next, missing } = fromWorkspaceFile(parsed.file, doc.value, (id) => records.value.has(id))
  resetSelection()
  doc.value = next
  barMessage.value =
    `Loaded "${next.name}" (${next.visualizations.length} visualizations) — Save to keep it.` +
    (missing.length ? ` ${missing.length} dataset${missing.length === 1 ? ' is' : 's are'} not in this database and ${missing.length === 1 ? 'was' : 'were'} left out.` : '')
  if (missing.length) logDebug(`workspace file: datasets not in the database: ${missing.join(', ')}`, 'warn')
}


/** The first visualization for a dataset added to the workspace, from a guessed binding. */
async function firstVisualizations(ds: DatasetRecord): Promise<VisualizationSpec[]> {
  const binding = guessBinding(ds.columns)
  if (!binding) return []
  const info = await describeBinding(ds.id, binding)
  return typeof info === 'string' || !info.features ? [] : [defaultVisualization(info, ds.id, binding)]
}

async function onAddDataset(datasetId: string) {
  importing.value = false
  const ds = await loadRecord(datasetId)
  if (!ds) return void logDebug(`dataset ${datasetId} not found in the database`, 'error')
  const first = await firstVisualizations(ds)
  if (!apply(addDataset(doc.value, ds.id, first))) return
  logDebug(`added "${ds.name}": ${ds.rowCount} rows${first.length ? '' : ' — pick how rows map to features in ＋ Add visualization'}`)
  if (first.length) setTimeout(() => zoomTo(ds.id), 300)
}

function removeDataset(id: string) {
  if (!apply(removeDataset_(doc.value, id))) return
  if (selected.value && vizById.value.get(selected.value.vizId)?.datasetId === id) selected.value = null
}

async function updateDataset(id: string, patch: { name?: string; description?: string }) {
  if (await call('update dataset', request('updateDataset', { id, ...patch }))) await loadRecord(id)
}
/** New visualization of a dataset column, on top of the list, open for editing. */
async function addVisualization(datasetId: string, binding: GeometryBinding, column: string) {
  const info = await describeBinding(datasetId, binding)
  if (typeof info === 'string') return void logDebug(info, 'error')
  const v = makeVisualization(info, datasetId, binding, column)
  if (apply(addVisualization_(doc.value, v, 0, opCtx))) vizList.value?.edit(v.id)
}

const updateVisualization = (v: VisualizationSpec) => apply(updateVisualization_(doc.value, v, opCtx))
const removeVisualization = (id: string) => apply(removeVisualization_(doc.value, id))
const reorderVisualizations = (ids: string[]) => apply(reorderVisualizations_(doc.value, ids))
const reorderDatasets = (ids: string[]) => apply(reorderDatasets_(doc.value, ids))

function zoomTo(datasetId: string) {
  const r = rendered.value.find((x) => x.layer.datasetId === datasetId)
  const b = r && focusBox(r.data.features.filter((f) => (f.properties[ROW_COUNT] as number) > 0).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b, 10)
}

/** The starting workspace: the EIA-861 utilities dataset (reused if already in the database) with its preset visualizations. */
async function seedDefault() {
  const existing = (await readDb.list('datasets')).find((d) => d.extensions?.preset === 'utilities')
  const id = existing?.id ?? (await call('load built-in data', request('uploadDataset', { source: { kind: 'builtin', table: UTILITY_TABLE } })))?.datasetId
  if (!id || !(await loadRecord(id))) throw new Error('could not load the built-in utilities dataset')
  apply(addDataset({ ...emptyWorkspace(), ...(doc.value.id ? { id: doc.value.id } : {}), name: UTILITY_NAME }, id, utilityVisualizations(id)))
}

/** Opens a saved workspace: its dataset pointers and visualization records. */
async function open(w: WorkspaceRecord) {
  const ids: string[] = []
  for (const id of w.config.datasetIds) {
    if (await loadRecord(id)) ids.push(id)
    else logDebug(`workspace "${w.name}": dataset ${id} is no longer in the database`, 'warn')
  }
  const vizs: VisualizationSpec[] = []
  for (const id of w.config.visualizationIds) {
    const v = await readDb.get('visualizations', id)
    if (!v || !ids.includes(v.datasetId)) continue
    // Older visualizations drew from a lat/lon pair; now they need a point column.
    if (!isSupportedBinding(v.settings.binding)) logDebug(`"${v.name}" used a lat/lon pair — add a point column to its dataset and visualize that`, 'warn')
    else vizs.push({ ...v.settings, id: v.id, name: v.name, datasetId: v.datasetId } as VisualizationSpec)
  }
  doc.value = { id: w.id, name: w.name, datasetIds: ids, visualizations: vizs }
  logDebug(`workspace "${w.name}" opened: ${ids.length} datasets, ${vizs.length} visualizations`)
}

/** Replaces the working copy with the default map (unsaved until Save). Datasets stay in the database. */
async function resetWorkspace() {
  if (!confirm('Reset this workspace to the default map? Nothing changes until you Save; your datasets stay in the database (＋ Add dataset → Saved).')) return
  resetSelection()
  await seedDefault()
  barMessage.value = ''
}

onMounted(async () => {
  try {
    const init = await request('init', { baseUrl: new URL(base, location.href).href })
    if (!init.ok) throw new Error(init.error.message)
    const all = await readDb.list('workspaces')
    const last = store.get(LAST_WORKSPACE)
    const w = all.find((x) => x.id === last) ?? all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    if (w) {
      await open(w)
      savedSnap.value = snapshot(doc.value)
      const draft = parseDraft(store.get(DRAFT))
      if (draft && draft.doc.id === w.id) {
        // Unsaved edits from last time; drop pointers to datasets that have since gone.
        for (const id of draft.doc.datasetIds) await loadRecord(id)
        const ids = draft.doc.datasetIds.filter((id) => records.value.has(id))
        doc.value = { ...draft.doc, datasetIds: ids, visualizations: draft.doc.visualizations.filter((v) => ids.includes(v.datasetId) && isSupportedBinding(v.binding)) }
        logDebug('restored unsaved changes from last time')
      }
    } else {
      await seedDefault()
      loaded.value = true
      await save() // the first workspace exists as soon as it's made
    }
    loaded.value = true
    status.value = 'ready'
  } catch (e) {
    status.value = 'error'
    errorMsg.value = (e as Error).message
    logDebug(`load failed: ${errorMsg.value}`, 'error')
  }
})

// ── visualization values (from the server; restyling never refetches) ─────

const valuesCache = new Map<string, Promise<LayerData | null>>()
const layers = shallowRef(new Map<string, { key: string; data: LayerData; byKey: Map<string, LayerFeature> }>())

const queryKey = (v: VisualizationSpec) => `${v.datasetId}|${JSON.stringify(v.binding)}|${v.column}|${v.aggregation}`
const layerKey = (v: VisualizationSpec) => `${queryKey(v)}|${v.name}|${records.value.get(v.datasetId)?.name}|${records.value.get(v.datasetId)?.updatedAt}`

function fetchLayer(v: VisualizationSpec): Promise<LayerData | null> {
  const k = queryKey(v)
  let p = valuesCache.get(k)
  if (!p) {
    p = (async () => {
      const values = await call(`values for "${v.name}"`, request('queryVisualization', { datasetId: v.datasetId, binding: v.binding, column: v.column, aggregation: v.aggregation }))
      if (!values) return null
      if (values.unmatched) logDebug(`"${v.name}": ${values.unmatched} rows had no feature (e.g. ${values.unmatchedSamples.slice(0, 5).join(', ')})`, 'warn')
      const boundaries = v.binding.kind === 'boundary' ? await loadBoundaries(v.binding.boundary) : undefined
      return visualizationLayer(values, v, '', boundaries)
    })()
    p.then((x) => x || valuesCache.delete(k))
    valuesCache.set(k, p)
  }
  return p
}

watch(
  () => visualizations.value.map(layerKey).join('\n'),
  async () => {
    for (const v of visualizations.value) {
      const key = layerKey(v)
      if (layers.value.get(v.id)?.key === key) continue
      const raw = await fetchLayer(v)
      const now = vizById.value.get(v.id)
      if (!raw || !now || layerKey(now) !== key) continue
      const ds = records.value.get(v.datasetId)
      const data: LayerData = { ...raw, id: v.id, name: `${ds?.name ?? ''} · ${v.name}`, fields: raw.fields.map((f) => (f.name === VALUE ? { ...f, alias: v.name } : f)) }
      layers.value = new Map(layers.value).set(v.id, { key, data, byKey: new Map(data.features.map((f) => [String(f.id), f])) })
    }
  },
  { immediate: true },
)

const vizById = computed(() => new Map(visualizations.value.map((v) => [v.id, v])))
const dataFor = (v: VisualizationSpec) => layers.value.get(v.id)?.data ?? null

const rendered = computed(() =>
  visualizations.value.flatMap((l) => {
    const e = layers.value.get(l.id)
    const ds = records.value.get(l.datasetId)
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
const selected = ref<{ vizId: string; key: string } | null>(null)
const selectedRows = shallowRef<DataRecord[] | null>(null)

/** Visualizations drawing the same features (same dataset and binding) as `v`. */
const siblingsOf = (v: VisualizationSpec, visibleOnly = false) =>
  visualizations.value.filter((x) => x.datasetId === v.datasetId && JSON.stringify(x.binding) === JSON.stringify(v.binding) && (!visibleOnly || x.visible))

function onHover(layerId: string, h: HoverInfo | null) {
  if (!canHover) return
  hover.value = h ? { ...h, layerId } : hover.value?.layerId === layerId ? null : hover.value
}
async function onSelect(layerId: string, key: string) {
  const v = vizById.value.get(layerId)
  hover.value = null
  if (!v) return
  selected.value = { vizId: layerId, key }
  selectedRows.value = null
  const rows = await call('feature rows', request('featureRows', { datasetId: v.datasetId, binding: v.binding, key }))
  if (selected.value?.vizId === layerId && selected.value.key === key) selectedRows.value = rows ?? []
}

/** A visualization's value on a feature, as display text. */
function displayValue(l: VisualizationSpec, key: string): string {
  const e = layers.value.get(l.id)
  const p = e?.byKey.get(key)?.properties
  return p ? formatPrimitive(p[VALUE], e!.data.fields[0].type) : '—'
}

const hoverCard = computed(() => {
  const h = hover.value
  const r = h && renderedById.value.get(h.layerId)
  if (!h || !r) return null
  const f = layers.value.get(r.layer.id)?.byKey.get(h.featureId)
  if (!f) return null
  return {
    x: h.x,
    y: h.y,
    title: String(f.properties._label),
    rows: [...siblingsOf(r.layer, true).map((l) => ({ label: l.name, value: displayValue(l, h.featureId) })), { label: 'Rows', value: String(f.properties[ROW_COUNT]) }],
  }
})

const selectedFeature = computed(() => {
  const s = selected.value
  const r = s && renderedById.value.get(s.vizId)
  const feature = r && layers.value.get(r.layer.id)?.byKey.get(s!.key)
  return r && feature ? { viz: r.layer, ds: r.ds, layer: r.data, feature, key: s!.key } : null
})
const selectedKeyFor = (v: VisualizationSpec) => {
  const s = selected.value && vizById.value.get(selected.value.vizId)
  return s && s.datasetId === v.datasetId && JSON.stringify(s.binding) === JSON.stringify(v.binding) ? selected.value!.key : null
}

// ── utility search (preset extra) ──────────────────────────────────────────

const searchBox = ref<{ clear: () => void }>()
const selectedUtility = ref<Utility | null>(null)
const utilityDs = computed(() => datasets.value.find((d) => d.extensions?.preset === 'utilities'))
const utilityName = (u: Utility) => u.utility_name
const utilityDetail = (u: Utility) => `${u.entity_type} · ${u.states.join(', ')} · ${u.county_fips.length} counties`
function pickUtility(id: number) {
  const u = utilities.value.find((x) => x.utility_id_eia === id) ?? null
  selectedUtility.value = u
  const r = rendered.value.find((x) => x.layer.datasetId === utilityDs.value?.id && x.layer.binding.kind === 'boundary')
  if (!u || !r) return
  const keys = new Set(u.county_fips)
  const b = focusBox(r.data.features.filter((f) => keys.has(String(f.id))).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b)
}
function clearUtility() {
  selectedUtility.value = null
  searchBox.value?.clear()
}
const highlightFor = (v: VisualizationSpec) => (presetOf(v.datasetId) === 'utilities' ? (selectedUtility.value?.county_fips ?? []) : [])

// ── legend ─────────────────────────────────────────────────────────────────

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

// ── export ─────────────────────────────────────────────────────────────────

const exportTarget = ref<string | null>(null)
const exportLayer = computed(() => (renderedById.value.get(exportTarget.value ?? '') ?? rendered.value[0])?.data ?? null)
</script>

<template>
  <div class="page">
    <section class="controls">
      <WorkspaceBar
        :name="doc.name"
        :dirty="dirty"
        :saving="saving"
        :message="barMessage"
        @save="save"
        @revert="revert"
        @rename="rename"
        @download="download"
        @load="loadFile"
        @reset="resetWorkspace"
      />
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
          :viz-count="(id) => visualizations.filter((v) => v.datasetId === id).length"
          @zoom="zoomTo"
          @remove="removeDataset"
          @reorder="reorderDatasets"
          @update="updateDataset"
        />
        <div class="import-wrap">
          <AddDatasetPanel v-if="importing" :in-workspace="doc.datasetIds" @add="onAddDataset" @cancel="importing = false" />
          <button v-else class="import-btn" @click="importing = true">＋ Add dataset</button>
        </div>
      </details>

      <details class="box">
        <summary>Export (ArcGIS)</summary>
        <label class="row">
          Visualization
          <select :value="exportTarget ?? rendered[0]?.layer.id" @change="exportTarget = ($event.target as HTMLSelectElement).value">
            <option v-for="r in rendered" :key="r.layer.id" :value="r.layer.id">{{ r.ds.name }} · {{ r.layer.name }}</option>
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
            :highlight-ids="highlightFor(r.layer)"
            :selected-id="selectedKeyFor(r.layer)"
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
          <FeaturePanel v-if="selectedFeature" :layer="selectedFeature.layer" :feature="selectedFeature.feature" @close="selected = null">
            <dl class="values">
              <template v-for="l in siblingsOf(selectedFeature.viz)" :key="l.id">
                <dt>{{ l.name }}</dt>
                <dd>{{ displayValue(l, selectedFeature.key) }}</dd>
              </template>
            </dl>
            <p v-if="!selectedRows" class="muted small">Loading rows…</p>
            <UtilityCountyDashboard
              v-else-if="selectedFeature.ds.extensions?.preset === 'utilities'"
              :rows="selectedRows"
              :selected-utility-id="selectedUtility?.utility_id_eia ?? null"
              @pick-utility="pickUtility"
            />
            <FeatureRows v-else :columns="selectedFeature.ds.columns" :rows="selectedRows" />
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

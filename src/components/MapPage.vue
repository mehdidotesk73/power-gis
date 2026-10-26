<script setup lang="ts">
// The map page — a client. It holds the working copy of a workspace
// (dataset pointers + ordered visualizations), reads registry records and
// rows from the database (read-only), and asks the server for everything
// lasting or heavy: uploads, dataset edits, each visualization's values,
// the rows behind a feature, and saving the workspace (on Save; until then
// edits are a draft kept on the device). Top of the
// visualization list draws on top. The starting workspace comes from a
// workspace file (public/data/default.powergis.json): built-in datasets, a
// join transform and its visualizations — nothing here knows what they hold.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import MapView from './map/MapView.vue'
import ScalarLayer from './map/ScalarLayer'
import VectorLayer from './map/VectorLayer'
import MapLegend from './map/MapLegend.vue'
import FeatureTooltip from './map/FeatureTooltip.vue'
import FeaturePanel from './map/FeaturePanel.vue'
import DataExchange from './map/DataExchange.vue'
import AddDatasetPanel from './dataset/AddDatasetPanel.vue'
import DatasetList from './dataset/DatasetList.vue'
import VisualizationList from './dataset/VisualizationList.vue'
import FeatureRows from './dataset/FeatureRows.vue'
import WorkspaceBar from './workspace/WorkspaceBar.vue'
import FindPanel, { type Found } from './FindPanel.vue'
import TransformsPanel, { type RunStatus } from './transform/TransformsPanel.vue'
import DagView from './dag/DagView.vue'
import { vReveal } from './reveal'
import type { HoverInfo } from './map/mapContext'
import { describeBinding, forgetBindingInfo } from './dataset/useBindingInfo'
import { request } from '../client/api'
import { readDb } from '../client/db'
import { BUILTIN_TABLES } from '../shared/builtins'
import type { DatasetRecord, WorkspaceRecord } from '../shared/records'
import type { DataRecord } from '../lib/data/connectors'
import { guessBinding, isSupportedBinding, type GeometryBinding } from '../lib/dataset/binding'
import { newId, ROW_COUNT } from '../lib/dataset/dataset'
import { buildDag, type DagNode } from '../lib/workspace/dag'
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
  addTransform as addTransform_,
  updateTransform as updateTransform_,
  removeTransform as removeTransform_,
  aliasFor,
  newOutput,
  normalizeTransform,
  type TransformSpec,
  type OpContext,
  type OpResult,
  type WorkspaceDoc,
} from '../lib/workspace/workspace'
import { fileName, fromWorkspaceFile, isPlaceholder, OUTPUT_REF, BUILTIN_REF, parseDraft, parseWorkspaceFile, replacePointers, snapshot, templateBuiltins, toWorkspaceFile, type Draft } from '../lib/workspace/file'
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
const loadingMsg = ref('Loading data…')

// ── workspace ──────────────────────────────────────────────────────────────

const doc = shallowRef<WorkspaceDoc>(emptyWorkspace())
/** Registry records of the workspace's datasets, read from the database. */
const records = shallowRef(new Map<string, DatasetRecord>())
const importing = ref(false)

const datasets = computed(() => doc.value.datasetIds.flatMap((id) => records.value.get(id) ?? []))
const visualizations = computed(() => doc.value.visualizations)
const opCtx: OpContext = { columns: (id) => records.value.get(id)?.columns.map((c) => c.name) }

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
    // Datasets stored before profiles existed get one (once; the server keeps it).
    if (!r.profile) void backfillProfile(id)
  }
  return r
}
async function backfillProfile(id: string) {
  if (!(await request('profileDataset', { datasetId: id })).ok) return
  const x = await readDb.get('datasets', id)
  if (x) records.value = new Map(records.value).set(id, x)
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
      transforms: d.transforms,
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
  clearFound()
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
  dagNewDataset.value = false
  const ds = await loadRecord(datasetId)
  if (!ds) return void logDebug(`dataset ${datasetId} not found in the database`, 'error')
  const first = await firstVisualizations(ds)
  if (!apply(addDataset(doc.value, ds.id, first))) return
  logDebug(`added "${ds.name}": ${ds.rowCount} rows${first.length ? '' : ' — pick how rows map to features in ＋ Add visualization'}`)
  if (first.length) setTimeout(() => zoomToViz(first[0].id), 300)
  if (view.value === 'graph') openNode({ key: `ds:${ds.id}`, kind: 'dataset', id: ds.id })
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
  if (!apply(addVisualization_(doc.value, v, 0, opCtx))) return
  if (view.value === 'graph') openNode({ key: `viz:${v.id}`, kind: 'viz', id: v.id }, true)
  else vizList.value?.edit(v.id)
}

const updateVisualization = (v: VisualizationSpec) => apply(updateVisualization_(doc.value, v, opCtx))
const removeVisualization = (id: string) => apply(removeVisualization_(doc.value, id))
const reorderVisualizations = (ids: string[]) => apply(reorderVisualizations_(doc.value, ids))
const reorderDatasets = (ids: string[]) => apply(reorderDatasets_(doc.value, ids))

// ── side panel: width (desktop) and popping out ────────────────────────────

// Drag the splitter between the controls and the map; the width is remembered per device.
const PANEL_W = 'powergis.panelWidth'
const panelMin = 256
const panelMax = () => Math.max(panelMin, Math.round(window.innerWidth * 0.7))
const clampPanel = (w: number) => Math.min(panelMax(), Math.max(panelMin, Math.round(w)))
const panelWidth = ref(clampPanel(Number(store.get(PANEL_W)) || 336))
let dragFrom: { x: number; w: number } | null = null
function splitStart(e: PointerEvent) {
  dragFrom = { x: e.clientX, w: panelWidth.value }
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* the window listeners below still hear it */
  }
  window.addEventListener('pointermove', splitMove)
  window.addEventListener('pointerup', splitEnd, { once: true })
  window.addEventListener('pointercancel', splitEnd, { once: true })
}
function splitMove(e: PointerEvent) {
  if (dragFrom) panelWidth.value = clampPanel(dragFrom.w + e.clientX - dragFrom.x)
}
function splitEnd() {
  dragFrom = null
  window.removeEventListener('pointermove', splitMove)
  window.removeEventListener('pointerup', splitEnd)
  window.removeEventListener('pointercancel', splitEnd)
  store.set(PANEL_W, String(panelWidth.value))
}
function splitKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 64 : 16
  if (e.key === 'ArrowLeft') panelWidth.value = clampPanel(panelWidth.value - step)
  else if (e.key === 'ArrowRight') panelWidth.value = clampPanel(panelWidth.value + step)
  else return
  e.preventDefault()
  store.set(PANEL_W, String(panelWidth.value))
}
function splitReset() {
  panelWidth.value = 336
  store.set(PANEL_W, null)
}

// The workspace panels (List / Graph and what's under them) can pop out into a
// large modal. One Teleport moves the same components, so nothing is lost.
const popped = ref(false)
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && popped.value) popped.value = false
}
onMounted(() => window.addEventListener('keydown', onEsc))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEsc)
  splitEnd()
})

// ── graph (DAG) view of the workspace ──────────────────────────────────────

// Controls show as one graph (the default) or as lists; the choice is remembered per device.
const VIEW = 'powergis.controlsView'
const view = ref<'list' | 'graph'>(store.get(VIEW) === 'list' ? 'list' : 'graph')
watch(view, (v) => {
  store.set(VIEW, v)
  closeNode()
})
const dag = computed(() => buildDag(doc.value, (id) => records.value.get(id)))
/** The node open under the graph (by key, so it follows edits and disappears when deleted). */
const dagKey = ref<string | null>(null)
const dagNode = computed(() => dag.value.nodes.find((n) => n.key === dagKey.value) ?? null)
/** ＋ Visualization: the dataset whose add form is open under the graph. */
const dagNewViz = ref<string | null>(null)
/** ＋ Dataset: the add-dataset form is open under the graph. */
const dagNewDataset = ref(false)
const dagViz = ref<InstanceType<typeof VisualizationList>>()
const dagTr = ref<InstanceType<typeof TransformsPanel>>()

/** Shows a node's card under the graph (hold it for options); `edit` opens its editor (new items). */
async function openNode(n: Pick<DagNode, 'key' | 'kind' | 'id'> | null, edit = false) {
  dagNewViz.value = null
  dagNewDataset.value = false
  dagKey.value = n?.key ?? null
  if (!edit) return
  await nextTick()
  if (n?.kind === 'transform') dagTr.value?.edit(n.id)
  else if (n?.kind === 'viz') dagViz.value?.edit(n.id)
}
function closeNode() {
  dagKey.value = null
  dagNewViz.value = null
  dagNewDataset.value = false
}
function newDataset() {
  closeNode()
  dagNewDataset.value = true
}
async function newVizFor(datasetId: string) {
  dagKey.value = null
  dagNewDataset.value = false
  dagNewViz.value = datasetId
  await nextTick()
  dagViz.value?.addFor(datasetId)
}
/** ＋ Transform: a new transform reading the picked datasets, open in its editor. */
function newTransformFrom(datasetIds: string[]) {
  const used = new Set<string>()
  const inputs = datasetIds.map((datasetId) => {
    const base = aliasFor(records.value.get(datasetId)?.name ?? 'input')
    let alias = base
    for (let i = 2; used.has(alias); i++) alias = `${base}_${i}`
    used.add(alias)
    return { datasetId, alias }
  })
  const also = inputs.length > 1 ? `\n-- also: ${inputs.slice(1).map((i) => i.alias).join(', ')}` : ''
  const t: TransformSpec = { id: newId(), name: 'New transform', inputs, outputs: [newOutput('New transform', `SELECT *\nFROM ${inputs[0].alias}${also}`)] }
  if (apply(addTransform_(doc.value, t))) openNode({ key: `tr:${t.id}`, kind: 'transform', id: t.id }, true)
}

// ── transforms ─────────────────────────────────────────────────────────────

const runStatus = ref<Record<string, RunStatus>>({})
const nameOf = (id: string) => records.value.get(id)?.name

/** Runs a transform on the server (all its outputs together); new output datasets join the workspace (with a first visualization when they have geometry). */
async function runTransform(id: string) {
  const t = doc.value.transforms.find((x) => x.id === id)
  if (!t) return
  runStatus.value = { ...runStatus.value, [id]: { state: 'running' } }
  const r = await request('runTransform', { transform: t })
  if (!r.ok) {
    runStatus.value = { ...runStatus.value, [id]: { state: 'error', message: r.error.message } }
    return
  }
  const lines: string[] = []
  for (const { datasetId, rowCount } of r.data.outputs) {
    forgetBindingInfo(datasetId)
    const ds = await loadRecord(datasetId) // a new updatedAt: its visualizations re-query
    if (ds && !doc.value.datasetIds.includes(datasetId)) apply(addDataset(doc.value, datasetId, await firstVisualizations(ds)))
    lines.push(`${rowCount.toLocaleString()} rows → ${ds?.name ?? 'dataset'}`)
  }
  // Each output remembers the dataset it wrote.
  const now = doc.value.transforms.find((x) => x.id === id)
  if (now) {
    const outputs = now.outputs.map((o) => ({ ...o, outputId: r.data.outputs.find((w) => w.key === o.key)?.datasetId ?? o.outputId }))
    apply(updateTransform_(doc.value, { ...now, outputs }))
  }
  runStatus.value = { ...runStatus.value, [id]: { state: 'done', message: lines.join(' · ') } }
  logDebug(`transform "${t.name}": ${lines.join(' · ')}`)
}

/** Fits the map to a visualization's features (those with rows). */
function zoomToViz(vizId: string) {
  const r = renderedById.value.get(vizId)
  const b = r && focusBox(r.data.features.filter((f) => (f.properties[ROW_COUNT] as number) > 0).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b, 10)
}

/**
 * The starting workspace, from the default workspace file: its built-in
 * datasets are uploaded (or current copies reused), its transforms run in
 * order (or an earlier output of the same SQL over the same inputs reused),
 * then it opens like any loaded file.
 */
async function seedDefault() {
  const res = await fetch(`${base}data/default.powergis.json`)
  const parsed = parseWorkspaceFile(res.ok ? await res.text() : '')
  if (!parsed.ok) throw new Error(`default workspace: ${parsed.error}`)
  const existing = await readDb.list('datasets')
  const ids = new Map<string, string>()
  for (const table of templateBuiltins(parsed.file)) {
    const version = BUILTIN_TABLES.find((b) => b.table === table)?.version
    const have = existing.find((d) => d.extensions?.builtin === table && d.extensions?.version === version)
    const id = have?.id ?? (await call(`load built-in ${table}`, request('uploadDataset', { source: { kind: 'builtin', table } })))?.datasetId
    if (!id) throw new Error(`could not load the built-in table "${table}"`)
    ids.set(BUILTIN_REF + table, id)
  }
  let file = replacePointers(parsed.file, (p) => ids.get(p))
  for (const [i, t] of (file.transforms ?? []).entries()) {
    // Each output's dataset is reused when an earlier run made it from the same SQL and inputs.
    const made = t.outputs.map((o) => JSON.stringify({ sql: o.sql, inputs: t.inputs }))
    const found = made.map((m) => existing.find((d) => d.extensions?.madeBy === m)?.id)
    if (found.some((id) => !id)) {
      loadingMsg.value = `Running "${t.name}" (the first run loads the SQL engine)…`
      const outputs = t.outputs.map((o, j) => ({ ...o, outputId: found[j] }))
      const r = await call(`transform "${t.name}"`, request('runTransform', { transform: { ...t, id: `seed-${i}`, outputs } }))
      if (!r) throw new Error(`the default transform "${t.name}" failed`)
      for (const [j, o] of t.outputs.entries()) {
        found[j] = r.outputs.find((w) => w.key === o.key)!.datasetId
        await request('updateDataset', { id: found[j]!, extensions: { madeBy: made[j] } })
      }
    }
    found.forEach((id, j) => {
      ids.set(`${OUTPUT_REF}${i}.${j}`, id!)
      if (j === 0) ids.set(OUTPUT_REF + i, id!)
    })
    file = replacePointers(file, (p) => ids.get(p))
  }
  for (const id of file.datasetIds) if (!isPlaceholder(id)) await loadRecord(id)
  apply({ ok: true, doc: fromWorkspaceFile(file, { ...emptyWorkspace(), ...(doc.value.id ? { id: doc.value.id } : {}) }, (id) => records.value.has(id)).doc })
  loadingMsg.value = 'Loading data…'
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
    // Older visualizations drew from a lat/lon pair or region codes; now they need a geometry column.
    if (!isSupportedBinding(v.settings.binding)) {
      logDebug(`"${v.name}" drew from lat/lon or region codes — make a geometry column with a transform (or ⋯ → Reset for the default map)`, 'warn')
      barMessage.value = 'Some visualizations used an older way of placing rows and were left out — ⋯ → Reset gets the default map.'
    }
    else vizs.push({ ...v.settings, id: v.id, name: v.name, datasetId: v.datasetId } as VisualizationSpec)
  }
  const transforms: TransformSpec[] = []
  for (const id of w.config.transformIds ?? []) {
    const t = await readDb.get('transforms', id)
    // Records saved before multi-output transforms have one `sql` + `outputId`.
    const old = t as typeof t & { sql?: string; outputId?: string }
    if (t) transforms.push(normalizeTransform({ id: t.id, name: t.name, inputs: t.inputs, outputs: t.outputs, sql: old.sql, outputId: old.outputId }))
  }
  for (const t of transforms) for (const o of t.outputs) if (o.outputId) await loadRecord(o.outputId) // output names for the panel
  doc.value = { id: w.id, name: w.name, datasetIds: ids, visualizations: vizs, transforms }
  logDebug(`workspace "${w.name}" opened: ${ids.length} datasets, ${vizs.length} visualizations, ${transforms.length} transforms`)
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

// Keyed by the dataset's updatedAt too: a transform re-run rewrites the table.
const queryKey = (v: VisualizationSpec) => `${v.datasetId}|${records.value.get(v.datasetId)?.updatedAt}|${JSON.stringify(v.binding)}|${v.column}|${v.aggregation}`
const layerKey = (v: VisualizationSpec) => `${queryKey(v)}|${v.name}|${records.value.get(v.datasetId)?.name}`

function fetchLayer(v: VisualizationSpec): Promise<LayerData | null> {
  const k = queryKey(v)
  let p = valuesCache.get(k)
  if (!p) {
    p = (async () => {
      const values = await call(`values for "${v.name}"`, request('queryVisualization', { datasetId: v.datasetId, binding: v.binding, column: v.column, aggregation: v.aggregation }))
      if (!values) return null
      if (values.unmatched) logDebug(`"${v.name}": ${values.unmatched} rows had no feature (e.g. ${values.unmatchedSamples.slice(0, 5).join(', ')})`, 'warn')
      return visualizationLayer(values, v, '')
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

// ── find (any visualization's features by name or text value) ──────────────

const found = ref<Found | null>(null)
const findable = computed(() =>
  rendered.value.map((r) => ({ viz: r.layer, label: `${r.layer.name} · ${r.ds.name}` })),
)
function onFound(f: Found) {
  found.value = f
  const r = renderedById.value.get(f.vizId)
  if (!r) return
  const keys = new Set(f.keys)
  const b = focusBox(r.data.features.filter((x) => keys.has(String(x.id))).map((x) => x.geometry))
  if (b) mapView.value?.fitBounds(b)
}
function clearFound() {
  found.value = null
}
/** Highlighted features: the found ones, on every visualization drawing the same features. */
const highlightFor = (v: VisualizationSpec) => {
  const f = found.value
  const fv = f && vizById.value.get(f.vizId)
  return fv && fv.datasetId === v.datasetId && JSON.stringify(fv.binding) === JSON.stringify(v.binding) ? f!.keys : []
}
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

const csvTables = BUILTIN_TABLES.filter((t) => t.source === 'csv').map((t) => t.table)
const exportTarget = ref<string | null>(null)
const exportLayer = computed(() => (renderedById.value.get(exportTarget.value ?? '') ?? rendered.value[0])?.data ?? null)
</script>

<template>
  <div class="page" :style="{ '--panel-w': `${panelWidth}px` }">
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
      <FindPanel class="search" :visualizations="findable" :found="found" @found="onFound" @clear="clearFound" />

      <div v-if="popped" class="popped-note">
        <span>Workspace panels are open in a window.</span>
        <button @click="popped = false">Bring back</button>
      </div>
      <Teleport to="body" :disabled="!popped">
      <div :class="popped ? 'pop-backdrop' : 'panels'" @click.self="popped = false">
      <div :class="popped ? 'pop' : 'panels'" :role="popped ? 'dialog' : undefined" :aria-modal="popped || undefined" aria-label="Workspace">
      <div class="view-row">
        <div class="view-switch" role="group" aria-label="Show as">
          <button :class="{ on: view === 'list' }" :aria-pressed="view === 'list'" @click="view = 'list'">List</button>
          <button :class="{ on: view === 'graph' }" :aria-pressed="view === 'graph'" @click="view = 'graph'">Graph</button>
        </div>
        <button class="pop-btn" :aria-label="popped ? 'Close window' : 'Open in a window'" :title="popped ? 'Close (Esc)' : 'Open in a window'" @click="popped = !popped">
          {{ popped ? '✕' : '⤢' }}
        </button>
      </div>

      <template v-if="view === 'graph'">
        <div class="graph-wrap" :class="{ split: dagNode || dagNewViz || dagNewDataset }">
        <section class="box">
          <DagView :dag="dag" :selected="dagKey" @select="openNode" @new-transform="newTransformFrom" @new-viz="newVizFor" @new-dataset="newDataset" />
        </section>
        <section v-if="dagNode || dagNewViz || dagNewDataset" v-reveal="dagKey ?? (dagNewViz ? `new-viz:${dagNewViz}` : 'new-dataset')" class="box dag-detail">
          <div class="dag-detail-head">
            <strong>{{ dagNewDataset ? 'New dataset' : dagNewViz ? 'New visualization' : dagNode!.kind === 'dataset' ? 'Dataset' : dagNode!.kind === 'transform' ? 'Transform' : 'Visualization' }}</strong>
            <button class="close" aria-label="Close" @click="closeNode">✕</button>
          </div>
          <AddDatasetPanel v-if="dagNewDataset" :in-workspace="doc.datasetIds" @add="onAddDataset" @cancel="closeNode" />
          <VisualizationList
            v-else-if="dagNewViz || dagNode?.kind === 'viz'"
            ref="dagViz"
            compact
            :visualizations="visualizations.filter((v) => v.id === dagNode?.id)"
            :datasets="datasets"
            :data-for="dataFor"
            @add="addVisualization"
            @update="updateVisualization"
            @remove="removeVisualization"
            @reorder="reorderVisualizations"
            @zoom="zoomToViz"
            @cancel-add="closeNode"
          />
          <DatasetList
            v-else-if="dagNode?.kind === 'dataset'"
            compact
            :datasets="records.has(dagNode.id) ? [records.get(dagNode.id)!] : []"
            :viz-count="(id) => visualizations.filter((v) => v.datasetId === id).length"
            @remove="removeDataset"
            @reorder="reorderDatasets"
            @update="updateDataset"
          />
          <TransformsPanel
            v-else-if="dagNode?.kind === 'transform'"
            ref="dagTr"
            compact
            :transforms="doc.transforms.filter((t) => t.id === dagNode!.id)"
            :all-transforms="doc.transforms"
            :datasets="datasets"
            :name-of="nameOf"
            :status="runStatus"
            @add="(t) => apply(addTransform_(doc, t))"
            @update="(t) => apply(updateTransform_(doc, t))"
            @remove="(id) => apply(removeTransform_(doc, id))"
            @run="runTransform"
          />
        </section>
        </div>
      </template>

      <template v-else>
        <details class="box">
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
            @zoom="zoomToViz"
          />
        </details>

        <details class="box">
          <summary>Datasets</summary>
          <div class="import-wrap">
            <AddDatasetPanel v-if="importing" v-reveal :in-workspace="doc.datasetIds" @add="onAddDataset" @cancel="importing = false" />
            <button v-else class="import-btn" @click="importing = true">＋ Add dataset</button>
          </div>
          <DatasetList
            :datasets="datasets"
            :viz-count="(id) => visualizations.filter((v) => v.datasetId === id).length"
            @remove="removeDataset"
            @reorder="reorderDatasets"
            @update="updateDataset"
          />
        </details>

        <details class="box">
          <summary>Transforms</summary>
          <TransformsPanel
            :transforms="doc.transforms"
            :datasets="datasets"
            :name-of="nameOf"
            :status="runStatus"
            @add="(t) => apply(addTransform_(doc, t))"
            @update="(t) => apply(updateTransform_(doc, t))"
            @remove="(id) => apply(removeTransform_(doc, id))"
            @run="runTransform"
          />
        </details>

      </template>
      </div>
      </div>
      </Teleport>

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
          Built-in CSVs:
          <template v-for="(t, i) in csvTables" :key="t">
            <template v-if="i"> · </template>
            <a :href="`${base}data/${t}.csv`" download>{{ t }}.csv</a>
          </template>
        </p>
      </details>
    </section>

    <div
      class="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      :aria-valuenow="panelWidth"
      tabindex="0"
      title="Drag to resize · double-click to reset"
      @pointerdown.prevent="splitStart"
      @keydown="splitKey"
      @dblclick="splitReset"
    />

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
            {{ status === 'loading' ? loadingMsg : `Couldn't load data: ${errorMsg}` }}
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
  grid-template-columns: var(--panel-w, 21rem) 0.75rem minmax(0, 1fr);
  height: calc(100dvh - 9rem);
  min-height: 32rem;
}
.controls {
  min-width: 0; /* a wide editor must not widen the column past the screen */
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
.splitter {
  position: relative;
  cursor: col-resize;
  touch-action: none;
}
.splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 3px;
  transform: translateX(-50%);
  border-radius: 2px;
  background: var(--border);
  transition: background 0.15s;
}
.splitter:hover::after,
.splitter:focus-visible::after,
.splitter:active::after {
  background: var(--accent-blue);
}
.panels {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.popped-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: 1px dashed var(--border);
  border-radius: 0.45rem;
  color: var(--text-muted);
  font-size: 0.8rem;
}
.popped-note button,
.pop-btn {
  min-height: 2.2rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-elev);
  color: var(--text);
}
.popped-note button {
  padding: 0 0.7rem;
}
.pop-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 2.5vh 3vw;
  background: rgb(0 0 0 / 0.45);
}
.pop {
  box-sizing: border-box;
  width: min(72rem, 100%);
  max-height: 95dvh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.8rem;
  border: 1px solid var(--border);
  border-radius: 0.7rem;
  background: var(--bg);
  color: var(--text);
  font-size: 0.85rem;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.35);
}
.pop :deep(.scroll) {
  max-height: 60dvh;
}
.graph-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
/* Popped out on a wide screen: the open item sits right of the graph, not under it. */
@media (min-width: 56rem) {
  .pop .graph-wrap.split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(22rem, 30rem);
    align-items: start;
  }
  .pop .graph-wrap.split :deep(.scroll) {
    max-height: calc(95dvh - 10rem);
  }
  .pop .graph-wrap.split .dag-detail {
    position: sticky;
    top: 0;
    max-height: calc(95dvh - 6rem);
    overflow: auto;
  }
  .pop .graph-wrap.split .dag-detail-head {
    position: sticky;
    top: -0.45rem;
    z-index: 1;
    background: var(--bg);
  }
}
.view-row {
  display: flex;
  gap: 0.4rem;
  align-items: stretch;
}
.view-row .view-switch {
  flex: 1;
}
.pop-btn {
  width: 2.6rem;
  font-size: 1.05rem;
}
.view-switch {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.view-switch button {
  flex: 1;
  min-height: 2.2rem;
  border: none;
  border-radius: 0.35rem;
  background: none;
  color: var(--text-muted);
  font-size: 0.85rem;
}
.view-switch button.on {
  background: var(--bg-elev);
  color: var(--text);
  font-weight: 600;
}
.dag-detail {
  display: grid;
  gap: 0.4rem;
}
.dag-detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.dag-detail-head .close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1rem;
  min-width: 2.2rem;
  min-height: 2.2rem;
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
  margin-bottom: 0.45rem; /* above the list, as the other panels' ＋ buttons */
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
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 70dvh auto;
    gap: 0.75rem;
    height: auto;
  }
  .splitter {
    display: none;
  }
  .pop-backdrop {
    padding: 0;
  }
  .pop {
    width: 100%;
    height: 100dvh;
    max-height: none;
    border-radius: 0;
    padding: 0.7rem 0.75rem calc(0.7rem + env(safe-area-inset-bottom));
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

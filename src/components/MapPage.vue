<script setup lang="ts">
// The map page — a client. It holds the working copy of a workspace
// (dataset pointers + ordered visualizations), reads registry records and
// rows from the database (read-only), and asks the server for everything
// lasting or heavy: uploads, dataset edits, each visualization's values,
// the rows behind a feature, and saving the workspace (on Save; until then
// edits are a draft kept on the device). Top of the
// visualization list draws on top. The starting workspace comes from a
// default folder's workspace file (defaults/<folder>/workspace.powergis.json): built-in datasets,
// transforms and visualizations — nothing here knows what they hold.
import UiButton from './ui/UiButton.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import MapView from './map/MapView.vue'
import ScalarLayer from './map/ScalarLayer'
import VectorLayer from './map/VectorLayer'
import MapLegend from './map/MapLegend.vue'
import FeatureTooltip from './map/FeatureTooltip.vue'
import FeaturePanel from './map/FeaturePanel.vue'
import DataExchange from './map/DataExchange.vue'
import AddDatasetPanel from './dataset/AddDatasetPanel.vue'
import DatasetEditor from './dataset/DatasetEditor.vue'
import DatasetList from './dataset/DatasetList.vue'
import VisualizationList from './dataset/VisualizationList.vue'
import FeatureRows from './dataset/FeatureRows.vue'
import WorkspaceBar from './workspace/WorkspaceBar.vue'
import BatchPanel, { type BatchItem } from './dataset/BatchPanel.vue'
import SharePanel from './dataset/SharePanel.vue'
import type { CloudAction } from './dataset/DatasetList.vue'
import FindPanel, { type Found } from './FindPanel.vue'
import TransformsPanel, { type RunStatus } from './transform/TransformsPanel.vue'
import DagView from './dag/DagView.vue'
import { vReveal } from './reveal'
import { DETAIL_ID, provideDetailTarget } from './detailTarget'
import { useSplitter } from './useSplitter'
import type { HoverInfo } from './map/mapContext'
import { describeBinding, forgetBindingInfo } from './dataset/useBindingInfo'
import { request } from '../client/api'
import { auth, syncCloudAuth } from '../client/auth'
import { readDb } from '../client/db'
import { listDatasets } from '../client/datasets'
import { BUILTIN_TABLES } from '../shared/builtins'
import { localSyncState, storeOf, type DatasetRecord, type SyncState, type WorkspaceRecord } from '../shared/records'
import type { DataRecord } from '../lib/data/connectors'
import { guessBinding, isSupportedBinding, type GeometryBinding } from '../lib/dataset/binding'
import { newId, ROW_COUNT } from '../lib/dataset/dataset'
import { buildDag, staleRunOrder, type DagNode } from '../lib/workspace/dag'
import { defaultVisualization, makeVisualization, settingsOf, visualizationLayer, VALUE, type VisualizationSpec } from '../lib/dataset/visualization'
import {
  addDataset,
  addVisualization as addVisualization_,
  emptyWorkspace,
  removeDataset as removeDataset_,
  forgetDataset,
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
  workspaceRequires,
  editDataset,
  withEdits,
  type TransformSpec,
  type OpContext,
  type OpResult,
  type UnavailableDataset,
  type WorkspaceDoc,
} from '../lib/workspace/workspace'
import { downstreamOrder, onlyOnThisDevice, removeUnavailable as removeUnavailable_, replaceDataset as replaceDataset_, unavailability, unavailableInfo } from '../lib/workspace/unavailable'
import { fromWorkspaceFile, missingReport, overviewOf, parseDraft, parseWorkspaceFile, snapshot, toWorkspaceFile, type Draft, type Parsed, type WorkspaceFile } from '../lib/workspace/file'
import { unzipDocument, zipDocument, zipName } from '../lib/workspace/files'
import { saveFile } from '../client/saveFile'
import { focusBox } from '../lib/geometry'
import { colorLegend, MAGNITUDE_FIELD, patternLegend, vectorOf, type LegendEntry } from '../lib/style'
import { fieldLabel, type LayerData, type LayerFeature } from '../lib/schema'
import { formatPrimitive } from '../lib/format'
import { logDebug } from '../debug'
import AgentPanel from './agent/AgentPanel.vue'
import type { AgentHost } from '../lib/agent/tools'
import type { Caller } from '../shared/api'

const base = import.meta.env.BASE_URL
const mapView = ref<InstanceType<typeof MapView>>()
const vizList = ref<{ edit: (id: string) => void }>()
const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorMsg = ref('')
const loadingMsg = ref('Loading data…')

// ── workspace ──────────────────────────────────────────────────────────────

const doc = shallowRef<WorkspaceDoc>(emptyWorkspace())
/** Registry records of the workspace's datasets, as read from the database. */
const stored = shallowRef(new Map<string, DatasetRecord>())
/** The same with the draft's name / description changes on top: what the page shows and documents carry. */
const records = computed(() => {
  if (!doc.value.datasetEdits) return stored.value
  return new Map([...stored.value].map(([id, r]) => [id, withEdits(doc.value, r)]))
})
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
    stored.value = new Map(stored.value).set(id, r)
    // Datasets stored before profiles existed get one (once; the server keeps it).
    if (!r.profile) void backfillProfile(id)
  }
  return r
}
async function backfillProfile(id: string) {
  if (!(await request('profileDataset', { datasetId: id })).ok) return
  const x = await readDb.get('datasets', id)
  if (x) stored.value = new Map(stored.value).set(id, x)
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
/** The default map is being prepared: it replaces the working copy when done, so ＋ waits until then. */
const seeding = ref(false)
const canAdd = computed(() => loaded.value && status.value === 'ready' && !seeding.value)

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
  const ok = await saveHere()
  saving.value = false
  if (!ok) return void (barMessage.value = 'Save failed — see View logs. Your changes are kept as a draft.')
  // This save is newer than the account's copy until it's sent: a catch-up must send it, never open the older one over it.
  if (auth.user) store.set(CLOUD_PENDING, auth.user.id)
  if (auth.user && cloudUser.value !== auth.user.id) await catchUpWithCloud() // the last check failed: try again (it saves here when the account has none)
  await saveToCloud()
  // Signed in, say what other devices (and anyone it's shared with) won't have.
  const local = localOnly.value
  const changed = outOfSync.value.filter((d) => d.state === 'ahead' || d.state === 'both')
  if ((local.length || changed.length) && !barMessage.value) {
    const quote = (l: { name: string }[]) => l.map((d) => `"${d.name}"`).join(', ')
    barMessage.value = [
      'Saved.',
      local.length ? `${local.length === 1 ? '1 dataset is' : `${local.length} datasets are`} only on this device (${quote(local)}): other devices, and anyone you share with, will see ${local.length === 1 ? 'it' : 'them'} as missing.` : '',
      changed.length ? `${changed.length === 1 ? '1 linked dataset has' : `${changed.length} linked datasets have`} changes here not pushed to the cloud (${quote(changed)}): Sync… pushes them.` : '',
    ].filter(Boolean).join(' ')
  }
}

/** Saves the working copy on this device (the server's database); true when it worked. */
async function saveHere(): Promise<boolean> {
  if (!(await saveDatasetEdits())) return false
  const d = doc.value
  const r = await call(
    'save workspace',
    request('saveWorkspace', {
      id: d.id,
      name: d.name,
      config: { datasetIds: d.datasetIds, ...(d.unavailable ? { unavailable: d.unavailable } : {}) },
      visualizations: d.visualizations.map((v) => ({ id: v.id, name: v.name, datasetId: v.datasetId, settings: settingsOf(v) })),
      transforms: d.transforms,
    }),
  )
  if (!r) return false
  savedSnap.value = snapshot(d)
  if (!doc.value.id) doc.value = { ...doc.value, id: r.workspaceId }
  store.set(LAST_WORKSPACE, r.workspaceId)
  return true
}

// ── the signed-in user's workspace in the cloud ────────────────────────────
//
// Signed in, Save also stores the workspace in the account (made portable:
// built-ins and transform outputs are rebuilt on the device that opens it).
// On load and on sign-in the page catches up with the account: a cloud
// workspace saved since this device last saw it opens here (asking first
// over unsaved changes); an account with none yet gets this device's.

/** `<user id>:<updatedAt>` of the cloud workspace this device last saved or opened. */
const CLOUD_SEEN = 'powergis.cloudSeen'
/** `<user id>` when this device's last save didn't reach the account: the next catch-up sends it up instead of opening the account's older one. */
const CLOUD_PENDING = 'powergis.cloudPending'
/** The user whose cloud workspace this page has caught up with (null: signed out, or not yet). */
const cloudUser = ref<string | null>(null)
const cloudError = ref('')
const savedWhere = computed(() =>
  !auth.user
    ? 'on this device'
    : cloudError.value
      ? `on this device — not in your account (${cloudError.value}; Save tries again)`
      : cloudUser.value !== auth.user.id
        ? 'on this device (checking your account…)'
        : 'on this device and in your account',
)
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

async function saveToCloud() {
  const user = auth.user?.id
  if (!user || cloudUser.value !== user || dirty.value) return
  const file = documentOf(doc.value)
  const r = await request('saveCloudWorkspace', { file, overview: overviewOf(file) })
  if (!r.ok) {
    cloudError.value = r.error.message
    store.set(CLOUD_PENDING, user)
    logDebug(`save to your account: ${r.error.message}`, 'warn')
    barMessage.value = `Saved on this device, but not in your account: ${r.error.message}. Save again to retry; it's also sent next time the app opens.`
    return
  }
  cloudError.value = ''
  store.set(CLOUD_PENDING, null)
  store.set(CLOUD_SEEN, `${user}:${r.data.updatedAt}`)
}

async function catchUpWithCloud() {
  const user = auth.user?.id
  if (!user || !loaded.value || cloudUser.value === user) return
  const r = await request('cloudWorkspace', {})
  if (auth.user?.id !== user) return
  if (!r.ok) {
    cloudError.value = r.error.message
    logDebug(`your account's workspace: ${r.error.message}`, 'warn')
    return
  }
  cloudUser.value = user
  cloudError.value = ''
  const w = r.data.workspace
  if (!w) return void (await saveToCloud()) // a new account: this device's workspace becomes its own
  // This device saved after the account's copy but couldn't send it: send it now, rather than open the older one.
  if (store.get(CLOUD_PENDING) === user) {
    await saveToCloud()
    if (!cloudError.value) barMessage.value = 'Sent your last save to your account (it had not reached it).'
    return
  }
  if (store.get(CLOUD_SEEN) === `${user}:${w.updatedAt}`) return
  store.set(CLOUD_SEEN, `${user}:${w.updatedAt}`)
  if (dirty.value && !confirm(`Your account has a workspace saved ${when(w.updatedAt)}. Open it here? Your unsaved changes on this device will be replaced.`)) {
    barMessage.value = 'Kept your changes here. Save stores them in your account, replacing the one there.'
    return
  }
  const report = await openHere(w.file, 'Opening your workspace from your account…')
  if (report === null) return
  await saveHere()
  barMessage.value = `Opened your workspace from your account (saved ${when(w.updatedAt)}).` + (report ? `\n${report}` : '')
}

/** The workspace as a document: its setup plus the facts of every dataset it points at (Copy, files, the cloud). */
const documentOf = (d: WorkspaceDoc): WorkspaceFile => toWorkspaceFile(d, (id) => records.value.get(id))

/**
 * Opens a workspace document (any version) as the working copy: the server makes its datasets real
 * here (built-ins, transform outputs) and says what it couldn't. Answers the report of what's
 * missing ('' when nothing is), or null when it couldn't open at all.
 */
async function openHere(file: unknown, loading: string): Promise<string | null> {
  status.value = 'loading'
  loadingMsg.value = loading
  const o = await call('open the workspace', request('openDocument', { file }))
  status.value = 'ready'
  if (!o) return null
  for (const id of o.file.datasetIds) await loadRecord(id)
  const next = fromWorkspaceFile(o.file, { ...emptyWorkspace(), ...(doc.value.id ? { id: doc.value.id } : {}) }, (id) => records.value.has(id), o.missing)
  resetSelection()
  doc.value = next.doc
  const u = unavailability(next.doc, (id) => records.value.has(id))
  const waiting = {
    visualizations: next.doc.visualizations.filter((v) => u.visualizations.has(v.id)).map((v) => v.name),
    transforms: next.doc.transforms.filter((t) => u.transforms.has(t.id)).map((t) => t.name),
  }
  const report = missingReport(o.missing, o.failed, waiting)
  if (report) logDebug(`workspace "${next.doc.name}": ${report.replace(/\n/g, ' ')}`, 'warn')
  return report
}
watch([() => auth.user?.id, loaded], ([user]) => {
  if (!user) cloudUser.value = null
  else void catchUpWithCloud()
})

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

/** Downloads the workspace as a zip of its files (lib/workspace/files.ts): workspace.json, datasets.json, SQL files, … */
function download() {
  // On phones this opens the share sheet (Save to Files): Safari's own download left Copy / Paste / Load dead.
  void saveFile(new Blob([zipDocument(documentOf(doc.value))], { type: 'application/zip' }), zipName(doc.value.name))
}

/** Copies the workspace (the same JSON as a workspace file) to the clipboard. */
async function copyWorkspace() {
  const text = JSON.stringify(documentOf(doc.value), null, 2)
  try {
    await navigator.clipboard.writeText(text)
    barMessage.value = 'Workspace copied — paste it anywhere (Workspace → Paste workspace loads it back).'
  } catch {
    barMessage.value = "Couldn't copy to the clipboard on this device — use Download workspace file instead."
  }
}

/** A workspace file: a zip of its files (what Download makes), or a document's JSON (older downloads, Copy). */
async function loadFile(f: File) {
  const bytes = new Uint8Array(await f.arrayBuffer())
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b // "PK"
  await loadWorkspaceText(zipped ? unzipDocument(bytes) : parseWorkspaceFile(new TextDecoder().decode(bytes)), 'file')
}

/** Replaces the working copy with a workspace document (from a file or pasted text). */
async function loadWorkspaceText(input: string | Parsed, from: 'file' | 'paste') {
  const parsed = typeof input === 'string' ? parseWorkspaceFile(input) : input
  if (!parsed.ok) return void (barMessage.value = parsed.error)
  if (dirty.value && !confirm(`Replace your unsaved changes with the ${from === 'file' ? 'workspace from this file' : 'pasted workspace'}?`)) return
  const report = await openHere(parsed.file, 'Opening the workspace…')
  if (report === null) return void (barMessage.value = "Couldn't open that workspace — see View logs.")
  barMessage.value = `Loaded "${doc.value.name}" (${doc.value.visualizations.length} visualizations) — Save to keep it.` + (report ? `\n${report}` : '')
}


/** The first visualization for a dataset added to the workspace, from a guessed binding. */
async function firstVisualizations(ds: DatasetRecord): Promise<VisualizationSpec[]> {
  const binding = guessBinding(ds.columns)
  if (!binding) return []
  const info = await describeBinding(ds.id, binding)
  return typeof info === 'string' || !info.features ? [] : [defaultVisualization(info, ds.id, binding)]
}

/** New datasets join the workspace (each with a first visualization when it has geometry); the last one opens. */
async function onAddDataset(datasetIds: string[]) {
  importing.value = false
  dagNewDataset.value = false
  let last: { id: string; viz?: string } | null = null
  for (const datasetId of datasetIds) {
    const ds = await loadRecord(datasetId)
    if (!ds) {
      logDebug(`dataset ${datasetId} not found in the database`, 'error')
      continue
    }
    const first = await firstVisualizations(ds)
    if (!apply(addDataset(doc.value, ds.id, first))) continue
    logDebug(`added "${ds.name}": ${ds.rowCount} rows${first.length ? '' : ' — pick how rows map to features in ＋ Visualization'}`)
    last = { id: ds.id, viz: first[0]?.id }
  }
  if (!last) return
  const { id, viz } = last
  if (viz) setTimeout(() => zoomToViz(viz), 300)
  if (view.value === 'graph') openNode({ key: `ds:${id}`, kind: 'dataset', id })
}

function removeDataset(id: string) {
  if (!apply(removeDataset_(doc.value, id))) return
  if (selected.value && vizById.value.get(selected.value.vizId)?.datasetId === id) selected.value = null
}

/** Deletes a dataset from the database (after the user confirms). */
async function deleteDataset(id: string) {
  const ds = records.value.get(id)
  const where = ds && storeOf(ds) === 'remote' ? 'cloud storage' : 'this device'
  if (!confirm(`Delete "${ds?.name ?? id}" from ${where}? Its rows are gone for good, and its visualizations go with it (in other saved workspaces too).`)) return
  const r = await deleteForGood(id)
  if (!r.ok) alert(r.message)
}

/** Out of the workspace first (refused while a transform reads it), then the table. */
async function deleteForGood(id: string, by: Caller = 'user'): Promise<{ ok: true } | { ok: false; message: string }> {
  const next = forgetDataset(doc.value, id)
  if (!next.ok) return { ok: false, message: next.error.message }
  const r = await request('deleteDataset', { id }, by)
  if (!r.ok) return { ok: false, message: r.error.message }
  if (selected.value && vizById.value.get(selected.value.vizId)?.datasetId === id) selected.value = null
  apply(next)
  const left = new Map(stored.value)
  left.delete(id)
  stored.value = left
  return { ok: true }
}

/** A dataset's new name / description: a draft edit, written to the dataset on Save. */
function updateDataset(id: string, patch: { name?: string; description?: string }): { ok: true } | { ok: false; message: string } {
  const was = stored.value.get(id)
  if (!was) return { ok: false, message: `No dataset "${id}" on this device` }
  const r = editDataset(doc.value, id, patch, was)
  if (!r.ok) return { ok: false, message: r.error.message }
  apply(r)
  return { ok: true }
}

/** Writes the draft's dataset name / description changes to the datasets; true when all of them worked. */
async function saveDatasetEdits(): Promise<boolean> {
  const edits = doc.value.datasetEdits
  if (!edits) return true
  const left = { ...edits }
  for (const [id, patch] of Object.entries(edits)) {
    if (stored.value.has(id) && doc.value.datasetIds.includes(id) && !(await call('rename / describe dataset', request('updateDataset', { id, ...patch })))) {
      doc.value = { ...doc.value, datasetEdits: left }
      return false
    }
    delete left[id]
    await loadRecord(id)
  }
  doc.value = { ...doc.value, datasetEdits: undefined }
  return true
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
const panel = useSplitter({ key: 'powergis.panelWidth', initial: 336, min: 256, maxShare: 0.7, side: 'left' })
const panelWidth = panel.size
// The assistant docks on the right (desktop), resizable the same way.
const assist = useSplitter({ key: 'powergis.assistantWidth', initial: 400, min: 300, maxShare: 0.5, side: 'right' })
// Setup's mini map: drag the bar above it to make it taller or shorter.
const minimap = useSplitter({ key: 'powergis.minimapHeight', initial: 220, min: 96, maxShare: 0.7, side: 'bottom' })
/** Setup's mini map starts minimized to a bar; tapping the bar opens it, ▾ minimizes it again. */
const mapMin = ref(true)
const minimapHeight = computed(() => (mode.value === 'setup' && mapMin.value ? '2.4rem' : `${minimap.size.value}px`))

// Two modes. Explore puts the map first: on desktop the List | Graph panel on
// the left, search above the map and export below it; on phones the map fills
// the page and setup waits in a bar left of the search. Setup puts building
// first: the page becomes one panel topped by List | Graph and ✕ — on desktop
// List | Graph over a mini map on the left and what you open (cards, editors,
// Explore) on the right; on phones List | Graph, then what you open, scrolling
// above a mini map anchored at the bottom. The same components and the one map
// change places, so nothing is lost on switching.
const mode = ref<'explore' | 'setup'>('explore')
const pageEl = ref<HTMLElement | null>(null)
// Editors, the graph's open item and Explore open in their own section: under List | Graph in the
// side panel (desktop explore, phone setup), the right column in desktop setup.
provideDetailTarget(computed(() => `#${DETAIL_ID}`))
const count = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
function setMode(m: 'explore' | 'setup') {
  mode.value = m
  // Phones: the page itself changes (and scrolls in setup); start the new mode at its top.
  nextTick(() => pageEl.value?.scrollTo({ top: 0 }))
}
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && mode.value === 'setup' && !document.querySelector('[role="dialog"]')) setMode('explore')
}
onMounted(() => window.addEventListener('keydown', onEsc))
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))

// ── graph (DAG) view of the workspace ──────────────────────────────────────

// Controls show as one graph (the default) or as lists; the choice is remembered per device.
const VIEW = 'powergis.controlsView'
const view = ref<'list' | 'graph'>(store.get(VIEW) === 'list' ? 'list' : 'graph')
watch(view, (v) => {
  store.set(VIEW, v)
  closeNode()
})
// What can't work on this device (datasets the workspace points at that aren't here, and what waits on them).
const present = (id: string) => records.value.has(id)
const unav = computed(() => unavailability(doc.value, present))
const WHY_SHORT: Record<UnavailableDataset['why'], string> = {
  elsewhere: 'on another device',
  cloud: 'in the cloud, not reachable',
  unknown: 'not on this device',
  builtin: 'built-in not available',
  output: 'not made here',
}
/** "plants", "prices" — the missing roots something waits on. */
const waitsFor = (roots: string[]) => roots.map((r) => `"${unavailableInfo(doc.value, r).name}"`).join(', ')
const dag = computed(() => {
  const d = buildDag(doc.value, (id) => records.value.get(id))
  const u = unav.value
  for (const n of d.nodes) {
    // An output not made on this device yet (its transform can run): its name, and what to do.
    if (n.kind === 'dataset' && !present(n.id) && !u.datasets.has(n.id)) Object.assign(n, { label: unavailableInfo(doc.value, n.id).name, detail: 'not made yet — run its transform' })
  }
  if (!u.datasets.size) return d
  for (const n of d.nodes) {
    const roots = n.kind === 'dataset' ? u.datasets.get(n.id) : n.kind === 'transform' ? u.transforms.get(n.id) : u.visualizations.get(n.id)
    if (!roots) continue
    if (n.kind === 'dataset' && u.roots.includes(n.id)) {
      const info = unavailableInfo(doc.value, n.id)
      Object.assign(n, { problem: 'missing', label: info.name, detail: WHY_SHORT[info.why] })
    } else Object.assign(n, { problem: 'waits', ...(n.kind === 'dataset' ? { label: unavailableInfo(doc.value, n.id).name } : {}), detail: `waits for ${waitsFor(roots)}` })
  }
  return d
})
/** The node open under the graph (by key, so it follows edits and disappears when deleted). */
const dagKey = ref<string | null>(null)
const dagNode = computed(() => dag.value.nodes.find((n) => n.key === dagKey.value) ?? null)
// Red marks in the lists: what can't work here and what it waits for.
const vizProblems = computed(() => new Map([...unav.value.visualizations].map(([id, roots]) => [id, `waits for ${waitsFor(roots)}`])))
const trProblems = computed(() => new Map([...unav.value.transforms].map(([id, roots]) => [id, `waits for ${waitsFor(roots)}`])))
/** What waits on a missing dataset here (its card says). */
const waitingOn = (root: string) => ({
  transforms: [...unav.value.transforms.values()].filter((r) => r.includes(root)).length,
  visualizations: [...unav.value.visualizations.values()].filter((r) => r.includes(root)).length,
})
/** Uploads kept only on this device (signed in, they're what other devices and other people won't have). */
const localOnly = computed(() => (auth.user ? onlyOnThisDevice(doc.value, (id) => records.value.get(id)) : []))
const problemCount = computed(() => unav.value.datasets.size + unav.value.transforms.size + unav.value.visualizations.size)

// ── cloud links ────────────────────────────────────────────────────────────
// Every dataset here is a local copy; a linked one also has a cloud dataset.
// Nothing reaches the cloud but the user's syncs: Link to cloud (the first
// push), and Push / Pull per dataset, chosen in a review panel (BatchPanel:
// Push · Pull · Skip on every line, the ones that don't apply disabled).
// Signed in, linked datasets' states are checked on load and every minute.

const SIGN_IN = 'Sign in (☰ → Sign in) to use the cloud.'
/** Short notes on dataset cards (a cloud action's outcome). */
const datasetNotes = ref(new Map<string, string>())
const noteOn = (id: string, text: string) => void (datasetNotes.value = new Map(datasetNotes.value).set(id, text))
function dismissNote(id: string) {
  const m = new Map(datasetNotes.value)
  m.delete(id)
  datasetNotes.value = m
}
const rows = (id: string) => (records.value.get(id)?.rowCount ?? 0).toLocaleString()

/** Linked datasets' states and push rights, as last checked against the cloud. */
const cloudStates = ref(new Map<string, { state: SyncState; canPush: boolean }>())
const syncStates = computed(() => {
  const m = new Map<string, SyncState>()
  for (const d of datasets.value) {
    if (!d.link) continue
    const known = cloudStates.value.get(d.id)?.state
    // A change made here since the last check shows at once.
    m.set(d.id, known === 'synced' && d.link.changed ? 'ahead' : known === 'behind' && d.link.changed ? 'both' : (known ?? localSyncState(d)!))
  }
  return m
})
const linked = computed(() => datasets.value.filter((d) => d.link))
/** Linked datasets that aren't in sync (what Sync all… lists). */
const outOfSync = computed(() => linked.value.filter((d) => syncStates.value.get(d.id) !== 'synced').map((d) => ({ id: d.id, name: d.name, state: syncStates.value.get(d.id)! })))

async function checkCloud(ids = linked.value.map((d) => d.id)) {
  if (!auth.user || !ids.length) return
  const r = await request('cloudStatus', { items: ids.map((id) => ({ id })) })
  if (!r.ok) return void logDebug(`cloud check: ${r.error.message}`, 'warn')
  const m = new Map(cloudStates.value)
  for (const x of r.data.datasets) m.set(x.id, { state: x.state, canPush: x.canPush })
  cloudStates.value = m
}
watch([() => auth.user?.id, loaded, () => linked.value.map((d) => d.id).join()], () => void checkCloud())
let cloudTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => (cloudTimer = setInterval(() => document.visibilityState === 'visible' && void checkCloud(), 60_000)))
onBeforeUnmount(() => clearInterval(cloudTimer))

const STATE_NOTE: Record<SyncState, string> = {
  synced: 'In sync with the cloud.',
  ahead: 'Changed here (↑): push to update the cloud.',
  behind: 'Newer in the cloud (↓): pull to update this copy.',
  both: 'Changed here and in the cloud (↑↓): push overwrites the cloud\'s version; pull replaces yours.',
  gone: 'No longer in the cloud: push puts it back.',
}

/** The dataset whose people are open (SharePanel). */
const sharing = ref<{ id: string; name: string } | null>(null)
async function onLeft() {
  const id = sharing.value!.id
  sharing.value = null
  await loadRecord(id)
  noteOn(id, 'Left ✓ — this copy is local only now')
}

async function cloudAction(action: CloudAction, id: string) {
  const ds = records.value.get(id)
  if (!ds) return
  if (!auth.user) return noteOn(id, SIGN_IN)
  if (action === 'sync') return void openSync([id])
  if (action === 'link') return void openLink([id])
  if (action === 'share') return void (sharing.value = { id, name: ds.name })
  if (action === 'unlink') {
    if (!confirm(`Unlink "${ds.name}" from the cloud? It stays here as a local dataset; the cloud dataset stays as it is.`)) return
    const r = await request('unlinkDataset', { id })
    await loadRecord(id)
    return noteOn(id, r.ok ? 'Unlinked ✓ — local only now' : r.error.message)
  }
  if (!confirm(`Delete "${ds.name}" from the cloud? Everyone's copies stay on their devices, unlinked. It can't be undone.`)) return
  const r = await request('deleteFromCloud', { id })
  await loadRecord(id)
  noteOn(id, r.ok ? 'Deleted from the cloud ✓ — this copy is local only now' : r.error.message)
}

/**
 * Signed in, datasets that didn't load here are looked for in the cloud (by their cloud id, or
 * their own id: they may have been linked since the workspace was saved) and pulled: they stop
 * being red. Each id is tried once per session; a failure leaves it as it was.
 */
const triedCloud = new Set<string>()
async function recoverFromCloud() {
  if (!auth.user || !loaded.value) return
  const ids = [...unav.value.datasets.keys()].filter((id) => !present(id) && !triedCloud.has(id))
  if (!ids.length) return
  if (!(await syncCloudAuth())) return
  ids.forEach((id) => triedCloud.add(id))
  const items = ids.map((id) => ({ id, ...(doc.value.unavailable?.[id]?.cloudId ? { cloudId: doc.value.unavailable[id].cloudId } : {}) }))
  const status = await request('cloudStatus', { items })
  if (!status.ok) return
  const found: string[] = []
  for (const s of status.data.datasets) {
    if (s.state === 'gone') continue
    const r = await request('pullDataset', { id: s.id, ...items.find((i) => i.id === s.id) })
    if (r.ok && (await loadRecord(s.id))) found.push(s.id)
  }
  if (!found.length) return
  const left = { ...doc.value.unavailable }
  const names = found.map((id) => `"${left[id]?.name ?? records.value.get(id)?.name ?? id}"`)
  for (const id of found) delete left[id]
  doc.value = { ...doc.value, unavailable: Object.keys(left).length ? left : undefined }
  barMessage.value = `Pulled from the cloud: ${names.join(', ')}.${unav.value.roots.length ? '' : ' Everything loads now.'}`
}
watch([() => auth.user?.id, loaded, () => unav.value.datasets.size], () => void recoverFromCloud())

// ── the review panel (BatchPanel) ──────────────────────────────────────────

const batch = ref<{ kind: 'sync' | 'link'; title: string; intro: string; items: BatchItem[]; running: boolean } | null>(null)

/** Sync: Push · Pull · Skip for each, the ones that don't apply disabled. */
async function openSync(ids: string[]) {
  if (!auth.user || !(await syncCloudAuth())) return void (barMessage.value = SIGN_IN)
  await checkCloud(ids)
  const items: BatchItem[] = ids.flatMap((id) => {
    const d = records.value.get(id)
    if (!d?.link) return []
    const state = syncStates.value.get(id) ?? 'synced'
    const canPush = cloudStates.value.get(id)?.canPush ?? true
    const push = state === 'synced' || state === 'behind' ? 'nothing to push' : !canPush ? 'you can only read this cloud dataset' : undefined
    const pull = state === 'synced' || state === 'ahead' ? 'nothing new in the cloud' : state === 'gone' ? 'it\'s no longer in the cloud' : undefined
    const choice = state === 'ahead' || state === 'gone' ? (push ? 'skip' : 'push') : state === 'behind' ? 'pull' : 'skip'
    return [
      {
        id,
        name: d.name,
        note: `${STATE_NOTE[state]} ${rows(id)} rows here.`,
        ...(state === 'both' ? { warn: 'Both changed: choose which wins, or skip.' } : {}),
        options: [
          { id: 'push', label: 'Push ↑', ...(push ? { disabled: push } : {}) },
          { id: 'pull', label: 'Pull ↓', ...(pull ? { disabled: pull } : {}) },
          { id: 'skip', label: 'Skip' },
        ],
        choice,
      },
    ]
  })
  if (!items.length) return
  batch.value = {
    kind: 'sync',
    items,
    running: false,
    title: 'Sync with the cloud',
    intro: 'Push sends this copy to the cloud; pull replaces this copy with the cloud\'s. Choose for each, then go ahead.',
  }
}

/** Link to cloud: Link · Skip for each local dataset (built-ins aren't linked). */
function openLink(ids: string[]) {
  const items: BatchItem[] = ids.flatMap((id) => {
    const d = records.value.get(id)
    if (!d || d.link) return []
    return [{ id, name: d.name, note: `Makes a cloud dataset from this one (${rows(id)} rows) and links them. Other devices can then pull it.`, options: [{ id: 'link', label: 'Link' }, { id: 'skip', label: 'Skip' }], choice: 'link' }]
  })
  if (!items.length) return
  batch.value = {
    kind: 'link',
    items,
    running: false,
    title: 'Link to the cloud',
    intro: 'Each stays here as it is, and gets a cloud copy you sync by hand (push and pull).',
  }
}
async function openBatch(kind: 'sync' | 'link') {
  if (!auth.user) return void (barMessage.value = SIGN_IN)
  if (kind === 'sync') await openSync(outOfSync.value.map((d) => d.id))
  else openLink(localOnly.value.map((d) => d.id))
}

async function runBatch() {
  const b = batch.value
  if (!b) return
  b.running = true
  if (!(await syncCloudAuth())) {
    for (const it of b.items) if (it.choice !== 'skip') ((it.status = 'failed'), (it.result = 'Not done: you are signed out. Sign in (☰ → Sign in) and try again.'))
    b.running = false
    return
  }
  for (const it of b.items) {
    if (it.choice === 'skip') {
      it.status = 'skipped'
      continue
    }
    it.status = 'running'
    const r =
      it.choice === 'link'
        ? await request('linkToCloud', { id: it.id })
        : it.choice === 'push'
          ? await request('pushDataset', { id: it.id, overwrite: !!it.warn || cloudStates.value.get(it.id)?.state === 'gone' })
          : await request('pullDataset', { id: it.id })
    await loadRecord(it.id)
    const done = { link: 'Linked ✓ — other devices can pull it', push: 'Pushed ✓ — the cloud has this version', pull: 'Pulled ✓ — this copy matches the cloud' }[it.choice as 'link' | 'push' | 'pull']
    it.status = r.ok ? 'done' : 'failed'
    it.result = r.ok ? done : r.error.code === 'conflict' ? 'Not pushed: it changed in the cloud meanwhile. Sync again to choose.' : `Not done: ${r.error.message}`
  }
  b.running = false
  await checkCloud()
}

/** The transform writing a dataset, by name (an output can't be replaced: its transform would overwrite it). */
const writtenBy = (id: string) => doc.value.transforms.find((t) => t.outputs.some((o) => o.outputId === id))?.name

/** After a replace: the transforms that read the new dataset, offered to run now. */
const afterReplace = ref<{ name: string; order: string[]; running: boolean; message: string } | null>(null)
async function replaceDataset(oldId: string, newId: string) {
  const name = records.value.get(oldId)?.name ?? unavailableInfo(doc.value, oldId).name
  const ds = await loadRecord(newId)
  if (!ds) return void logDebug(`replace "${name}": the new dataset isn't in the database`, 'error')
  const r = replaceDataset_(doc.value, oldId, newId)
  if (!r.ok) return void (barMessage.value = `Couldn't replace "${name}": ${r.error.message}`)
  apply(r)
  if (dagKey.value === `ds:${oldId}`) dagKey.value = `ds:${newId}`
  const order = downstreamOrder(doc.value, newId)
  afterReplace.value = order.length ? { name: `"${name}" → "${ds.name}"`, order, running: false, message: '' } : null
  barMessage.value = ''
}
async function runAfterReplace() {
  const a = afterReplace.value
  if (!a) return
  a.running = true
  for (const id of a.order) {
    const t = doc.value.transforms.find((x) => x.id === id)
    const r = await runTransform(id)
    if (!r.ok) {
      afterReplace.value = { ...a, running: false, message: `"${t?.name}" failed: ${r.message}` }
      return
    }
  }
  afterReplace.value = null
}
function removeUnavailable() {
  if (!confirm(`Remove the ${problemCount.value} items that didn't load on this device? Nothing changes until you Save (Discard brings them back).`)) return
  apply(removeUnavailable_(doc.value, present))
  barMessage.value = ''
}
function showUnavailable() {
  const root = unav.value.roots[0]
  if (!root) return
  view.value = 'graph'
  void openNode({ key: `ds:${root}`, kind: 'dataset', id: root })
}

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

type RunOutcome = { ok: true; outputs: { datasetId: string; name: string; rowCount: number; created: boolean }[] } | { ok: false; message: string }

/**
 * Runs a transform on the server (all its outputs together); new output
 * datasets join the workspace — with a first visualization when the user ran
 * it, without when an agent did (it sets up its own).
 */
async function runTransform(id: string, by: Caller = 'user'): Promise<RunOutcome> {
  const t = doc.value.transforms.find((x) => x.id === id)
  if (!t) return { ok: false, message: `No transform "${id}"` }
  runStatus.value = { ...runStatus.value, [id]: { state: 'running' } }
  const r = await request('runTransform', { transform: t }, by)
  if (!r.ok) {
    runStatus.value = { ...runStatus.value, [id]: { state: 'error', message: r.error.message } }
    return { ok: false, message: r.error.message }
  }
  // An output set to write a dataset this device doesn't have (a workspace opened elsewhere) wrote a new one: it takes the old one's place.
  for (const w of r.data.outputs) {
    const was = t.outputs.find((o) => o.key === w.key)?.outputId
    if (was && was !== w.datasetId && !records.value.has(was)) {
      await loadRecord(w.datasetId)
      apply(replaceDataset_(doc.value, was, w.datasetId))
    }
  }
  const lines: string[] = []
  const outputs: { datasetId: string; name: string; rowCount: number; created: boolean }[] = []
  for (const { datasetId, rowCount, created } of r.data.outputs) {
    forgetBindingInfo(datasetId)
    const ds = await loadRecord(datasetId) // a new updatedAt: its visualizations re-query
    if (ds && !doc.value.datasetIds.includes(datasetId)) apply(addDataset(doc.value, datasetId, by === 'user' ? await firstVisualizations(ds) : []))
    lines.push(`${rowCount.toLocaleString()} rows → ${ds?.name ?? 'dataset'}`)
    outputs.push({ datasetId, name: ds?.name ?? 'dataset', rowCount, created })
  }
  // Each output remembers the dataset it wrote; the transform, the engine extensions its SQL used.
  const now = doc.value.transforms.find((x) => x.id === id)
  if (now) {
    const { requires: _old, ...rest } = now
    const outputs = now.outputs.map((o) => ({ ...o, outputId: r.data.outputs.find((w) => w.key === o.key)?.datasetId ?? o.outputId }))
    apply(updateTransform_(doc.value, { ...rest, outputs, ...(r.data.requires.length ? { requires: r.data.requires } : {}) }))
  }
  runStatus.value = { ...runStatus.value, [id]: { state: 'done', message: lines.join(' · ') } }
  logDebug(`transform "${t.name}": ${lines.join(' · ')}`)
  return { ok: true, outputs }
}

// ── SQL engine extensions ──────────────────────────────────────────────────
// A workspace's transforms record the extensions their SQL uses (spatial…);
// they load in the background as soon as the workspace needs them, so the
// first run doesn't wait. (A query that needs one loads it anyway.)
const requested = new Set<string>()
watch(
  () => workspaceRequires(doc.value).join(','),
  async () => {
    const names = workspaceRequires(doc.value).filter((n) => !requested.has(n))
    if (!names.length) return
    for (const n of names) requested.add(n)
    const r = await request('loadSqlExtensions', { names })
    if (r.ok) logDebug(`SQL engine extensions: ${r.data.loaded.map((x) => `${x.name} (from ${x.from})`).join(', ')}`)
    else {
      for (const n of names) requested.delete(n)
      logDebug(`SQL engine extensions ${names.join(', ')} didn't load: ${r.error.message}`, 'warn')
    }
  },
  { immediate: true },
)

// ── the assistant (agent) ──────────────────────────────────────────────────
// The agent's tools act through the same functions as the UI (lib/agent/tools.ts).

const agentHost: Omit<AgentHost, 'ask'> = {
  async importCsv(file, description) {
    const r = await request('uploadDataset', { source: { kind: 'csv', file }, name: file.name.replace(/\.csv$/i, '') })
    if (!r.ok) return { ok: false, message: r.error.message }
    if (description) await request('updateDataset', { id: r.data.datasetId, description })
    await onAddDataset([r.data.datasetId])
    return { ok: true, id: r.data.datasetId }
  },
  doc: () => doc.value,
  setDoc(next) {
    doc.value = next
    for (const id of next.datasetIds) if (!records.value.has(id)) void loadRecord(id)
    if (selected.value && !next.visualizations.some((v) => v.id === selected.value?.vizId)) selected.value = null
  },
  dataset: (id) => readDb.get('datasets', id),
  record: (id) => records.value.get(id),
  listDatasets,
  query: (sql, inputs, limit) => request('previewTransform', { sql, inputs, limit }, 'agent'),
  shape: describeBinding,
  values: async (datasetId, binding, column, aggregation) => {
    const r = await request('queryVisualization', { datasetId, binding, column, aggregation })
    return r.ok ? r.data : r.error.message
  },
  runTransform: (id) => runTransform(id, 'agent'),
  deleteDataset: (id) => deleteForGood(id, 'agent'),
  updateDataset,
}
const assistantOpen = ref(false)

// ── Run all stale ──────────────────────────────────────────────────────────
// Every transform needing a re-run, plus everything downstream of one, inputs
// first (lib/workspace/dag.ts staleRunOrder). Stops at the first failure.
const staleOrder = computed(() => staleRunOrder(doc.value, (id) => records.value.get(id)))
/** "2 of 3 · Utilities by county" while running; the outcome after. */
const staleProgress = ref<{ running: boolean; text: string } | null>(null)
async function runAllStale() {
  const order = [...staleOrder.value]
  if (!order.length || staleProgress.value?.running) return
  for (const [i, id] of order.entries()) {
    const t = doc.value.transforms.find((x) => x.id === id)
    staleProgress.value = { running: true, text: `Running ${i + 1} of ${order.length}${t ? ` · ${t.name}` : ''}…` }
    await runTransform(id)
    const st = runStatus.value[id]
    if (st?.state === 'error') {
      staleProgress.value = { running: false, text: `⚠ “${t?.name ?? 'transform'}” failed: ${st.message ?? ''} — ${i} of ${order.length} ran.` }
      return
    }
  }
  staleProgress.value = { running: false, text: `✓ Re-ran ${order.length} transform${order.length === 1 ? '' : 's'}.` }
  setTimeout(() => {
    if (!staleProgress.value?.running) staleProgress.value = null
  }, 6000)
}

/** Fits the map to a visualization's features (those with rows). */
function zoomToViz(vizId: string) {
  const r = renderedById.value.get(vizId)
  const b = r && focusBox(r.data.features.filter((f) => (f.properties[ROW_COUNT] as number) > 0).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b, 10)
}

/**
 * The starting workspace: the server prepares the default workspace file
 * (seedDefaultWorkspace: built-ins uploaded or reused, transforms run or
 * reused) and it opens like any loaded file.
 */
async function seedDefault() {
  loadingMsg.value = 'Preparing the default map (the first time runs its transforms)…'
  seeding.value = true
  const r = await call('default workspace', request('seedDefaultWorkspace', {})).finally(() => (seeding.value = false))
  if (!r) throw new Error('the default workspace could not be prepared')
  for (const id of r.file.datasetIds) await loadRecord(id)
  // What couldn't be made here (a step whose SQL extension didn't download, say) stays, in red, and is reported.
  const next = fromWorkspaceFile(r.file, { ...emptyWorkspace(), ...(doc.value.id ? { id: doc.value.id } : {}) }, (id) => records.value.has(id), r.missing)
  apply({ ok: true, doc: next.doc })
  if (r.failed.length || r.missing.length) {
    const report = missingReport(r.missing, r.failed, { visualizations: [], transforms: [] })
    logDebug(`default map: ${report.replace(/\n/g, ' ')}`, 'warn')
    barMessage.value = `Parts of the default map couldn't be made here:\n${report}`
  }
  loadingMsg.value = 'Loading data…'
}

/** Opens a saved workspace: its dataset pointers and visualization records. */
async function open(w: WorkspaceRecord) {
  // Datasets not on this device stay, unavailable, with what's known of them (red until replaced or removed).
  const ids = [...w.config.datasetIds]
  const unavailable: Record<string, UnavailableDataset> = {}
  for (const id of ids) {
    if (await loadRecord(id)) continue
    unavailable[id] = w.config.unavailable?.[id] ?? { name: 'Unknown dataset', why: 'unknown' }
    logDebug(`workspace "${w.name}": dataset "${unavailable[id].name}" isn't on this device`, 'warn')
  }
  const vizs: VisualizationSpec[] = []
  for (const id of w.config.visualizationIds) {
    const v = await readDb.get('visualizations', id)
    if (!v || !ids.includes(v.datasetId)) continue
    // Older visualizations drew from a lat/lon pair or region codes; now they need a geometry column.
    if (!isSupportedBinding(v.settings.binding)) {
      logDebug(`"${v.name}" drew from lat/lon or region codes — make a geometry column with a transform (or Workspace → Reset for the default map)`, 'warn')
      barMessage.value = 'Some visualizations used an older way of placing rows and were left out — Workspace → Reset gets the default map.'
    }
    else vizs.push({ ...v.settings, id: v.id, name: v.name, datasetId: v.datasetId } as VisualizationSpec)
  }
  const transforms: TransformSpec[] = []
  for (const id of w.config.transformIds ?? []) {
    const t = await readDb.get('transforms', id)
    // Records saved before multi-output transforms have one `sql` + `outputId`.
    const old = t as typeof t & { sql?: string; outputId?: string }
    if (t) transforms.push(normalizeTransform({ id: t.id, name: t.name, inputs: t.inputs, outputs: t.outputs, sql: old.sql, outputId: old.outputId, ...(t.requires?.length ? { requires: t.requires } : {}) }))
  }
  for (const t of transforms) for (const o of t.outputs) if (o.outputId) await loadRecord(o.outputId) // output names for the panel
  for (const t of transforms) for (const id of [...t.inputs.map((i) => i.datasetId), ...t.outputs.flatMap((o) => (o.outputId ? [o.outputId] : []))]) {
    if (!records.value.has(id) && !unavailable[id] && w.config.unavailable?.[id]) unavailable[id] = w.config.unavailable[id]
  }
  doc.value = { id: w.id, name: w.name, datasetIds: ids, visualizations: vizs, transforms, ...(Object.keys(unavailable).length ? { unavailable } : {}) }
  logDebug(`workspace "${w.name}" opened: ${ids.length} datasets, ${vizs.length} visualizations, ${transforms.length} transforms`)
}

/** Replaces the working copy with the default map (unsaved until Save). Datasets stay in the database. */
async function resetWorkspace() {
  if (!confirm('Reset this workspace to the default map? Nothing changes until you Save; your datasets stay in the database (＋ Dataset → Saved).')) return
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
const exportViz = computed(() => (renderedById.value.get(exportTarget.value ?? '') ?? rendered.value[0])?.layer ?? null)
</script>

<template>
  <div ref="pageEl" class="page" :data-ready="loaded && status === 'ready' ? 'yes' : 'no'" :class="[mode, { assisting: assistantOpen }]" :style="{ '--panel-w': `${panelWidth}px`, '--assist-w': `${assist.size.value}px`, '--minimap-h': minimapHeight }">
    <!-- List | Graph and ⤢ / ✕: the top of the side panel in explore, of the whole page in setup. -->
    <div class="view-row">
      <div class="view-switch" role="group" aria-label="Show as">
        <button :class="{ on: view === 'list' }" :aria-pressed="view === 'list'" @click="view = 'list'">List</button>
        <button :class="{ on: view === 'graph' }" :aria-pressed="view === 'graph'" @click="view = 'graph'">Graph</button>
      </div>
      <UiButton
        class="pop-btn"
        :icon="mode === 'setup' ? '✕' : '⤢'"
        :aria-label="mode === 'setup' ? 'Back to the map' : 'Set up the workspace (full page)'"
        :title="mode === 'setup' ? 'Back to the map (Esc)' : 'Set up the workspace (full page)'"
        @click="setMode(mode === 'setup' ? 'explore' : 'setup')"
      />
    </div>
    <!-- The side panel's body: List | Graph, then what you open, scrolling together (desktop explore). -->
    <div class="panel-body">
    <section class="controls">
      <Teleport defer to="#header-workspace">
        <WorkspaceBar
          :name="doc.name"
          :dirty="dirty"
          :saving="saving"
          :message="barMessage"
          :where="savedWhere"
          :retry="!!cloudError"
          :problems="problemCount"
          :local-only="localOnly"
          :out-of-sync="outOfSync"
          :linked-count="linked.length"
          @link-all="openBatch('link')"
          @sync-all="openBatch('sync')"
          @remove-unavailable="removeUnavailable"
          @show-unavailable="showUnavailable"
          :counts="{ datasets: doc.datasetIds.length, transforms: doc.transforms.length, visualizations: doc.visualizations.length }"
          @save="save"
          @revert="revert"
          @rename="rename"
          @download="download"
          @load="loadFile"
          @copy="copyWorkspace"
          @paste="(text: string) => loadWorkspaceText(text, 'paste')"
          @reset="resetWorkspace"
        />
        <UiButton size="compact" icon="✦" :active="assistantOpen" :aria-pressed="assistantOpen" title="Assistant" aria-label="Assistant" @click="assistantOpen = !assistantOpen"><span class="ai-word">Assistant</span></UiButton>
      </Teleport>
      <div class="panels" aria-label="Workspace">
      <div v-if="afterReplace" v-reveal class="box after-replace">
        <span>Replaced {{ afterReplace.name }}. {{ afterReplace.order.length }} transform{{ afterReplace.order.length === 1 ? '' : 's' }} read{{ afterReplace.order.length === 1 ? 's' : '' }} it and can run now.</span>
        <span v-if="afterReplace.message" class="problem-note">{{ afterReplace.message }}</span>
        <span class="row-actions">
          <UiButton data-testid="run-them-now" size="tag" tone="transform" icon="▶" :disabled="afterReplace.running" @click="runAfterReplace">{{ afterReplace.running ? 'Running…' : 'Run them now' }}</UiButton>
          <UiButton size="tag" :disabled="afterReplace.running" @click="afterReplace = null">Not now</UiButton>
        </span>
      </div>

      <template v-if="view === 'graph'">
        <div class="graph-wrap" :class="{ split: dagNode || dagNewViz || dagNewDataset }">
        <section class="box">
          <DagView
            :dag="dag"
            :selected="dagKey"
            :stale-count="staleOrder.length"
            :stale-progress="staleProgress"
            :adding="canAdd"
            @select="openNode"
            @new-transform="newTransformFrom"
            @new-viz="newVizFor"
            @new-dataset="newDataset"
            @run-stale="runAllStale"
          />
        </section>
        <Teleport defer :to="`#${DETAIL_ID}`">
        <section v-if="dagNode || dagNewViz || dagNewDataset" v-reveal.late="dagKey ?? (dagNewViz ? `new-viz:${dagNewViz}` : 'new-dataset')" class="box dag-detail">
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
            :problems="vizProblems"
            @add="addVisualization"
            @update="updateVisualization"
            @remove="removeVisualization"
            @reorder="reorderVisualizations"
            @zoom="zoomToViz"
            @cancel-add="closeNode"
          />
          <DatasetEditor
            v-else-if="dagNode?.kind === 'dataset' && unav.roots.includes(dagNode.id)"
            :id="dagNode.id"
            :key="dagNode.id"
            :missing="{ info: unavailableInfo(doc, dagNode.id), waiting: waitingOn(dagNode.id) }"
            replace-open
            @replace="(newId) => replaceDataset(dagNode!.id, newId)"
          />
          <p v-else-if="dagNode?.kind === 'dataset' && unav.datasets.has(dagNode.id)" class="problem-note">
            ⚠ "{{ unavailableInfo(doc, dagNode.id).name }}" isn't on this device. It's made by a transform that waits for {{ waitsFor(unav.datasets.get(dagNode.id)!) }}: replace that, then run it.
          </p>
          <DatasetList
            v-else-if="dagNode?.kind === 'dataset'"
            compact
            :datasets="records.has(dagNode.id) ? [records.get(dagNode.id)!] : []"
            :tables="datasets"
            :viz-count="(id) => visualizations.filter((v) => v.datasetId === id).length"
            @remove="removeDataset"
            @delete="deleteDataset"
            :notes="datasetNotes"
            :sync-states="syncStates"
            @cloud="cloudAction"
            @dismiss-note="dismissNote"
            @reorder="reorderDatasets"
            @update="updateDataset"
            @replace="replaceDataset"
            :written-by="writtenBy"
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
            :problems="trProblems"
            @add="(t) => apply(addTransform_(doc, t))"
            @update="(t) => apply(updateTransform_(doc, t))"
            @remove="(id) => apply(removeTransform_(doc, id))"
            @run="runTransform"
          />
        </section>
        </Teleport>
        </div>
      </template>

      <template v-else>
        <details class="box">
          <summary>Visualizations</summary>
          <VisualizationList
            ref="vizList"
            :hide-add="!canAdd"
            :visualizations="visualizations"
            :datasets="datasets"
            :data-for="dataFor"
            :problems="vizProblems"
            @add="addVisualization"
            @update="updateVisualization"
            @remove="removeVisualization"
            @reorder="reorderVisualizations"
            @zoom="zoomToViz"
          />
        </details>

        <details class="box">
          <summary>Transforms</summary>
          <div v-if="staleOrder.length || staleProgress" class="stale-row">
            <UiButton v-if="staleOrder.length && !staleProgress?.running" data-testid="run-all-stale" size="tag" tone="attention" icon="↻" @click="runAllStale">Run all stale ({{ staleOrder.length }})</UiButton>
            <span v-if="staleProgress" class="stale-msg">{{ staleProgress.text }}</span>
          </div>
          <TransformsPanel
            :transforms="doc.transforms"
            :hide-add="!canAdd"
            :datasets="datasets"
            :name-of="nameOf"
            :status="runStatus"
            :problems="trProblems"
            @add="(t) => apply(addTransform_(doc, t))"
            @update="(t) => apply(updateTransform_(doc, t))"
            @remove="(id) => apply(removeTransform_(doc, id))"
            @run="runTransform"
          />
        </details>

        <details class="box">
          <summary>Datasets</summary>
          <div class="import-wrap">
            <AddDatasetPanel v-if="importing" v-reveal :in-workspace="doc.datasetIds" @add="onAddDataset" @cancel="importing = false" />
            <UiButton v-else-if="canAdd" size="tag" tone="dataset" icon="＋" @click="importing = true">Dataset</UiButton>
          </div>
          <DatasetEditor
            v-for="root in unav.roots"
            :id="root"
            :key="root"
            class="list-unavailable"
            :missing="{ info: unavailableInfo(doc, root), waiting: waitingOn(root) }"
            @replace="(newId) => replaceDataset(root, newId)"
          />
          <DatasetList
            :datasets="datasets"
            :viz-count="(id) => visualizations.filter((v) => v.datasetId === id).length"
            @remove="removeDataset"
            @delete="deleteDataset"
            :notes="datasetNotes"
            :sync-states="syncStates"
            @cloud="cloudAction"
            @dismiss-note="dismissNote"
            @reorder="reorderDatasets"
            @update="updateDataset"
            @replace="replaceDataset"
            :written-by="writtenBy"
          />
        </details>

      </template>
      </div>
    </section>
      <!-- What you open (cards, editors, Explore): under List | Graph, or the right column in desktop setup. -->
      <aside :id="DETAIL_ID" class="setup-detail" aria-label="Open item">
        <p class="muted aside-hint">Open a dataset, transform or visualization — tap a node, or double-tap a card — and it shows here.</p>
      </aside>
    </div>

    <div
      class="splitter panel-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      :aria-valuenow="panelWidth"
      tabindex="0"
      title="Drag to resize · double-click to reset"
      @pointerdown.prevent="panel.start"
      @keydown="panel.key"
      @dblclick="panel.reset"
    />

    <section class="map-col">
    <button v-if="mode === 'setup' && mapMin" data-testid="minimap.show" class="minimap-bar" aria-label="Show the map" @click="mapMin = false">
      <span aria-hidden="true">▴</span> Map
    </button>
    <UiButton
      v-if="mode === 'setup' && !mapMin"
      data-testid="minimap.hide"
      class="minimap-hide"
      size="compact"
      icon="▾"
      aria-label="Minimize the map"
      title="Minimize the map"
      @click="mapMin = true"
    />
    <div
      v-show="mode === 'setup' && !mapMin"
      class="splitter map-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the mini map"
      :aria-valuenow="minimap.size.value"
      tabindex="0"
      title="Drag to resize · double-click to reset"
      @pointerdown.prevent="minimap.start"
      @keydown="minimap.key"
      @dblclick="minimap.reset"
    />
    <div v-show="mode === 'explore'" class="top-row">
      <!-- Phones, explore: setup waits in a vertical bar left of the search. -->
      <button class="setup-dock" :title="`Set up · ${count(doc.datasetIds.length, 'dataset')} · ${count(doc.transforms.length, 'transform')} · ${count(doc.visualizations.length, 'visualization')}`" aria-label="Set up the workspace" @click="setMode('setup')">
        <span class="dock-icon" aria-hidden="true">▸</span>
        <span class="dock-text">Set up</span>
      </button>
      <FindPanel class="search" :visualizations="findable" :found="found" @found="onFound" @clear="clearFound" />
    </div>
    <section v-show="!(mode === 'setup' && mapMin)" class="map-wrap">
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
      <details v-show="mode === 'explore'" class="box export">
        <summary>Export (ArcGIS)</summary>
        <label class="row">
          Visualization
          <select :value="exportTarget ?? rendered[0]?.layer.id" @change="exportTarget = ($event.target as HTMLSelectElement).value">
            <option v-for="r in rendered" :key="r.layer.id" :value="r.layer.id">{{ r.ds.name }} · {{ r.layer.name }}</option>
          </select>
        </label>
        <DataExchange :visualization="exportViz" />
        <p class="muted small">
          Built-in CSVs:
          <template v-for="(t, i) in csvTables" :key="t">
            <template v-if="i"> · </template>
            <a :href="`${base}data/${t}.csv`" download>{{ t }}.csv</a>
          </template>
        </p>
      </details>
    </section>



    <!-- The assistant: a column docked on the right on desktop (a sheet over the page on phones). -->
    <div
      v-show="assistantOpen"
      class="splitter assist-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the assistant"
      :aria-valuenow="assist.size.value"
      tabindex="0"
      title="Drag to resize · double-click to reset"
      @pointerdown.prevent="assist.start"
      @keydown="assist.key"
      @dblclick="assist.reset"
    />
    <AgentPanel v-show="assistantOpen" class="assistant-col" :host="agentHost" @close="assistantOpen = false" />
    <SharePanel v-if="sharing" :id="sharing.id" :name="sharing.name" @close="sharing = null" @left="onLeft" />
    <BatchPanel v-if="batch" :title="batch.title" :intro="batch.intro" :items="batch.items" :running="batch.running" @proceed="runBatch" @close="batch = null" />
  </div>
</template>

<style scoped>
.problem-note {
  margin: 0;
  color: var(--danger);
  font-size: 0.8rem;
}
.after-replace {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.82rem;
}
.row-actions {
  display: flex;
  gap: 0.4rem;
}
.list-unavailable {
  margin-bottom: 0.45rem;
}
.page {
  display: grid;
  grid-template-columns: var(--panel-w, 21rem) 0.75rem minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas:
    'head split map'
    'controls split map';
  /* The page fits the screen (App.vue sizes .content to what header and footer leave); only panels scroll. */
  height: 100%;
  min-height: 0;
}
.panel-body {
  grid-area: controls;
  min-width: 0; /* a wide editor must not widen the column past the screen */
  min-height: 0;
  /* No scroll anchoring: when the card under the graph changes size, the browser would shift the
     scroll and move the graph between the two clicks of a double-click. */
  overflow-anchor: none;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  font-size: 0.85rem;
  padding-right: 0.15rem;
}
.controls,
.setup-detail {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
/* Setup: the body's two parts take their own places on the page. */
.page.setup .panel-body {
  display: contents;
}
.page.setup .controls {
  grid-area: controls;
}
.page.setup .setup-detail {
  grid-area: detail;
}
/* Explore: nothing open, nothing to say. */
.page.explore .aside-hint {
  display: none;
}
/* The map column: search above the map, export below it (explore mode). */
.map-col {
  grid-area: map;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.map-wrap {
  flex: 1;
  min-height: 0;
}
.panel-splitter {
  grid-area: split;
}
.assist-splitter {
  grid-area: asplit;
}
.page.assisting {
  grid-template-columns: var(--panel-w, 21rem) 0.75rem minmax(0, 1fr) 0.75rem var(--assist-w, 25rem);
  grid-template-areas:
    'head split map asplit assist'
    'controls split map asplit assist';
}
.assistant-col {
  grid-area: assist;
  min-height: 0;
}
.setup-dock {
  display: none;
}

/* Desktop setup: List | Graph fills the page, a mini map under it, what you open on the right. */
@media (min-width: 48.0625rem) {
  .page.setup {
    grid-template-columns: minmax(0, 1fr) 0.75rem minmax(22rem, 32rem);
    grid-template-rows: auto minmax(0, 1fr) var(--minimap-h, 14rem);
    grid-template-areas:
      'head head head'
      'controls . detail'
      'map . detail';
    row-gap: 0.6rem;
  }
  .page.setup.assisting {
    grid-template-columns: minmax(0, 1fr) 0.75rem minmax(20rem, 28rem) 0.75rem var(--assist-w, 25rem);
    grid-template-areas:
      'head head head asplit assist'
      'controls . detail asplit assist'
      'map . detail asplit assist';
  }
  .page.setup .panel-splitter {
    display: none;
  }
  .page.setup .controls,
  .page.setup .setup-detail {
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
  }
  .page.setup .controls {
    padding-right: 0.15rem;
  }
  .page.setup .setup-detail .dag-detail-head {
    position: sticky;
    top: -0.45rem;
    z-index: 1;
    background: var(--bg-elev);
  }
}
/* Setup: List | Graph and ✕ head the whole page, a rule under them. */
.page.setup .view-row {
  margin-bottom: 0;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}
/* Setup: the map is a mini map, as small as its slot (MapView's own minimum is for the full map). */
.page.setup .map-wrap :deep(.map-root) {
  min-height: 0;
}
.page.setup .map-col {
  overflow: hidden;
  gap: 0;
}
.setup-detail:has(> :not(.aside-hint)) .aside-hint {
  display: none;
}
.aside-hint {
  margin: 0.5rem 0.2rem;
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
/* Setup: the minimized map, a bar to tap; open, a ▾ in its corner minimizes it again. */
.minimap-bar {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 2.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.85rem;
}
.minimap-hide {
  position: absolute;
  top: 0;
  right: 0.4rem;
  z-index: 3;
}
/* Open, the drag bar is tall enough for ▾ at its end, clear of the map's own controls. */
.page.setup .map-splitter {
  height: 1.9rem;
}
.page.setup .map-col {
  position: relative;
}
/* Setup: the bar above the mini map; drag up for a taller map. Tall enough to grab with a thumb. */
.map-splitter {
  flex: none;
  height: 1rem;
  cursor: row-resize;
}
.map-splitter::after {
  top: 50%;
  bottom: auto;
  left: 50%;
  width: 3rem;
  height: 4px;
  transform: translate(-50%, -50%);
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
.graph-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.view-row {
  grid-area: head;
  display: flex;
  gap: 0.4rem;
  align-items: stretch;
  margin-bottom: 0.6rem;
}
.view-row .view-switch {
  flex: 1;
}
.pop-btn {
  /* as tall as the List | Graph switch beside it; a fixed width (a stretched height can't drive aspect-ratio) */
  height: auto;
  min-height: 0;
  width: 2.2rem;
  aspect-ratio: auto;
}
/* Phones, explore: a vertical Set up bar left of the search (hidden on desktop, where List | Graph shows). */
.top-row {
  display: flex;
  gap: 0.4rem;
  min-width: 0;
}
.top-row .search {
  flex: 1;
  min-width: 0;
}
.setup-dock {
  flex: none;
  width: 1.8rem;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 0.35rem;
  padding: 0.45rem 0;
  border: 1px solid var(--border-strong);
  border-radius: 0.5rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 600;
}
.dock-text {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  letter-spacing: 0.04em;
}
.dock-icon {
  color: var(--accent-blue);
}
/* Export below the map: opening it never pushes the map (or its own header) off the page; its body scrolls. */
.export {
  flex: none;
  max-height: 45%;
  overflow: auto;
}
.export summary {
  position: sticky;
  top: -0.45rem;
  z-index: 1;
  background: var(--bg-elev);
}
.map-wrap :deep(.map-root) {
  min-height: 8rem;
}
.view-switch {
  display: flex;
  gap: 3px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
}
.view-switch button {
  flex: 1;
  /* Slim: a switch, not a toolbar; ⤢ / ✕ beside it takes the same height. */
  min-height: 1.65rem;
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
  background: var(--bg-elev);
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
.stale-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.45rem;
}
.stale-msg {
  font-size: 0.74rem;
  color: var(--text-muted);
}
.import-wrap {
  margin-bottom: 0.45rem; /* above the list, as the other panels' ＋ buttons */
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
  background: var(--overlay-bg);
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
  /* Phones, explore: search, then the map filling what's left, then export; setup behind a button on the map. */
  .page,
  .page.assisting {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: 'map';
    gap: 0.6rem;
  }
  .splitter {
    display: none;
  }
  .page.setup .map-splitter {
    display: block;
  }
  .assistant-col,
  .assist-splitter {
    grid-area: auto;
  }
  .panel-body,
  .view-row {
    display: none;
  }
  .setup-dock {
    display: flex;
  }
  /* Phones, setup: List | Graph and ✕ on top, then List | Graph, then what you open — scrolling
     together above a mini map anchored at the bottom. */
  .page.setup,
  .page.setup.assisting {
    grid-template-rows: auto auto 1fr auto;
    grid-template-areas:
      'head'
      'controls'
      'detail'
      'map';
    overflow: auto;
    overflow-anchor: none;
    /* what opens scrolls into view between the sticky head and the mini map */
    scroll-padding-top: 3rem;
    scroll-padding-bottom: calc(var(--minimap-h, 14rem) + 0.6rem);
  }
  .page.setup .view-row {
    display: flex;
    position: sticky;
    top: 0;
    z-index: 5;
    background: var(--bg);
  }
  .page.setup .map-col {
    position: sticky;
    bottom: 0;
    z-index: 5;
    height: var(--minimap-h, 14rem);
    background: var(--bg);
  }
}
@media (max-width: 30rem) {
  .ai-word {
    display: none;
  }
}
</style>

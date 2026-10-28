// The workspace as a document (format version 2): what Copy / Paste, the
// cloud and workspace files carry. It holds the workspace's setup — dataset
// pointers, transforms with their SQL, visualizations with all their settings
// — and the facts about each dataset it points at (name, store, rows, where it
// came from), never rows. With the facts, a device that lacks a dataset can
// rebuild it (a built-in, a transform's output) or say exactly what's missing.
//
// The same content as files (the agent's layout, and the zip download) comes
// from and goes back to this document.

import type { VisualizationSettings, VisualizationSpec } from '../dataset/visualization'
import { newId } from '../dataset/dataset'
import { isSupportedBinding } from '../dataset/binding'
import { normalizeTransform, workspaceRequires, type TransformSpec, type WorkspaceDoc } from './workspace'
import type { DatasetRecord, DatasetStore } from '../../shared/records'
import { builtinTable } from '../../shared/builtins'

export const FILE_FORMAT = 'powergis-workspace'
export const FILE_VERSION = 2

/** Where a dataset came from: what a device without it can do about it. */
export type DatasetOrigin =
  | { kind: 'builtin'; table: string; version?: number }
  | { kind: 'output'; transform: string; output: string }
  | { kind: 'upload'; source: string }
  | { kind: 'unknown' }

/** What the workspace knows about a dataset it points at (a snapshot, taken when the document is made). */
export interface DatasetFact {
  id: string
  name: string
  description?: string
  store: DatasetStore
  rows?: number
  origin: DatasetOrigin
  /** Ids of the same dataset elsewhere: the original(s) a device's copy was made for. */
  sameAs?: string[]
}

export interface WorkspaceFile {
  format: typeof FILE_FORMAT
  version: typeof FILE_VERSION
  exportedAt?: string
  /** The workspace it was made from (informational). */
  workspaceId?: string
  name: string
  datasetIds: string[]
  /** One per dataset pointed at anywhere (datasetIds, inputs, outputs, visualizations). */
  datasets: DatasetFact[]
  transforms: TransformSpec[]
  /** Top of the list first; each with all its settings. */
  visualizations: VisualizationSpec[]
  /** SQL engine extensions its transforms use, together (for people to read; opening reads each transform's). */
  requires?: string[]
}

/** Every dataset id the workspace points at, in a stable order. */
export function pointers(w: Pick<WorkspaceFile, 'datasetIds' | 'transforms' | 'visualizations'>): string[] {
  const all = [...w.datasetIds, ...w.transforms.flatMap((t) => [...t.inputs.map((i) => i.datasetId), ...t.outputs.flatMap((o) => (o.outputId ? [o.outputId] : []))]), ...w.visualizations.map((v) => v.datasetId)]
  return [...new Set(all)]
}

/** A dataset's facts, from its record (if this device has it) and the workspace's transforms. */
export function datasetFact(id: string, record: DatasetRecord | undefined, transforms: TransformSpec[]): DatasetFact {
  const writer = transforms.find((t) => t.outputs.some((o) => o.outputId === id))
  const builtin = record?.extensions?.builtin
  const origin: DatasetOrigin = writer
    ? { kind: 'output', transform: writer.id, output: writer.outputs.find((o) => o.outputId === id)!.key }
    : typeof builtin === 'string'
      ? { kind: 'builtin', table: builtin, ...(typeof record?.extensions?.version === 'number' ? { version: record.extensions.version } : {}) }
      : record
        ? { kind: 'upload', source: record.origin }
        : { kind: 'unknown' }
  const copyOf = record?.extensions?.copyOf
  return {
    id,
    name: record?.name ?? (writer ? writer.outputs.find((o) => o.outputId === id)!.name : 'Unknown dataset'),
    ...(record?.description ? { description: record.description } : {}),
    store: record?.store ?? 'local',
    ...(record ? { rows: record.rowCount } : {}),
    origin,
    ...(Array.isArray(copyOf) && copyOf.length ? { sameAs: copyOf.filter((x): x is string => typeof x === 'string') } : {}),
  }
}

/** The document for a working copy; `record` reads this device's dataset registry. */
export function toWorkspaceFile(doc: WorkspaceDoc, record: (id: string) => DatasetRecord | undefined): WorkspaceFile {
  const transforms = doc.transforms.map((t) => normalizeTransform(t))
  const body = { datasetIds: [...doc.datasetIds], transforms, visualizations: doc.visualizations.map((v) => ({ ...v })) }
  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    ...(doc.id ? { workspaceId: doc.id } : {}),
    name: doc.name,
    ...body,
    datasets: pointers(body).map((id) => datasetFact(id, record(id), transforms)),
    ...(workspaceRequires(doc).length ? { requires: workspaceRequires(doc) } : {}),
  }
}

export const fileName = (doc: WorkspaceDoc) => `${doc.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'workspace'}.powergis.json`

type Parsed = { ok: true; file: WorkspaceFile } | { ok: false; error: string }
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

/** Validates a workspace document's text (a file, a paste, the cloud copy); version 1 is read and converted. The error says what's wrong. */
export function parseWorkspaceFile(text: string): Parsed {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return { ok: false, error: 'This is not valid JSON.' }
  }
  return parseWorkspaceObject(o)
}

export function parseWorkspaceObject(o: unknown): Parsed {
  if (!isObj(o) || o.format !== FILE_FORMAT) return { ok: false, error: 'This is not a PowerGIS workspace.' }
  if (o.version === 1) return upgradeV1(o)
  if (o.version !== FILE_VERSION) return { ok: false, error: `Workspace version ${o.version} isn't supported (expected ${FILE_VERSION}).` }
  if (!isStr(o.name) || !Array.isArray(o.datasetIds) || !o.datasetIds.every(isStr) || !Array.isArray(o.visualizations) || !Array.isArray(o.transforms) || !Array.isArray(o.datasets)) {
    return { ok: false, error: 'The workspace is incomplete or damaged.' }
  }
  for (const v of o.visualizations) if (!isVisualization(v, true)) return { ok: false, error: 'A visualization in the workspace is incomplete or damaged.' }
  for (const t of o.transforms) if (!isTransform(t, true)) return { ok: false, error: 'A transform in the workspace is incomplete or damaged.' }
  for (const d of o.datasets) if (!isFact(d)) return { ok: false, error: 'A dataset in the workspace is incomplete or damaged.' }
  const file = o as unknown as WorkspaceFile
  // A pointer without facts (hand-edited documents) gets the little that's known.
  const known = new Set(file.datasets.map((d) => d.id))
  const datasets = [...file.datasets, ...pointers(file).filter((id) => !known.has(id)).map((id) => datasetFact(id, undefined, file.transforms))]
  return { ok: true, file: { ...file, datasets, transforms: file.transforms.map((t) => normalizeTransform(t)) } }
}

function isVisualization(v: unknown, withId: boolean): boolean {
  if (!isObj(v)) return false
  const s = (withId ? v : v.settings) as Partial<VisualizationSettings> | undefined
  return (!withId || isStr(v.id)) && isStr(v.name) && isStr(v.datasetId) && !!s && (s.kind === 'scalar' || s.kind === 'vector') && !!s.binding && isStr(s.column) && !!s.style
}

function isTransform(t: unknown, withId: boolean): boolean {
  if (!isObj(t)) return false
  // Today's outputs list, or (older files) one `sql` + `outputId`.
  const outputsOk = Array.isArray(t.outputs) ? t.outputs.every((x) => isObj(x) && isStr(x.sql) && isStr(x.name) && isStr(x.key)) : isStr(t.sql)
  const requiresOk = t.requires === undefined || (Array.isArray(t.requires) && t.requires.every(isStr))
  return (!withId || isStr(t.id)) && isStr(t.name) && outputsOk && requiresOk && Array.isArray(t.inputs) && t.inputs.every((i) => isObj(i) && isStr(i.datasetId) && isStr(i.alias))
}

function isFact(d: unknown): boolean {
  if (!isObj(d) || !isStr(d.id) || !isStr(d.name) || (d.store !== 'local' && d.store !== 'remote') || !isObj(d.origin)) return false
  const o = d.origin
  return (
    (o.kind === 'builtin' && isStr(o.table)) ||
    (o.kind === 'output' && isStr(o.transform) && isStr(o.output)) ||
    (o.kind === 'upload' && isStr(o.source)) ||
    o.kind === 'unknown'
  )
}

// Version 1 (read only): visualizations and transforms without ids, dataset
// pointers that were ids or placeholders (`builtin:<table>`, `transform:<n>`
// for the n-th transform's first output, `transform:<n>.<m>` its m-th), and an
// optional `names` map. It becomes a version 2 document.
function upgradeV1(o: Obj): Parsed {
  if (!isStr(o.name) || !Array.isArray(o.datasetIds) || !o.datasetIds.every(isStr) || !Array.isArray(o.visualizations)) {
    return { ok: false, error: 'The workspace is incomplete or damaged.' }
  }
  for (const v of o.visualizations) if (!isVisualization(v, false)) return { ok: false, error: 'A visualization in the workspace is incomplete or damaged.' }
  const rawT = (o.transforms ?? []) as unknown[]
  if (!Array.isArray(rawT)) return { ok: false, error: 'A transform in the workspace is incomplete or damaged.' }
  for (const t of rawT) if (!isTransform(t, false)) return { ok: false, error: 'A transform in the workspace is incomplete or damaged.' }
  const transforms = rawT.map((t) => normalizeTransform({ ...(t as Omit<TransformSpec, 'id'>), id: newId() }))
  const visualizations = (o.visualizations as { name: string; datasetId: string; settings: VisualizationSettings }[]).map(
    (v) => ({ ...v.settings, id: newId(), name: v.name, datasetId: v.datasetId }) as VisualizationSpec,
  )
  const body = { datasetIds: o.datasetIds as string[], transforms, visualizations }
  const names = isObj(o.names) ? o.names : {}
  const datasets = pointers(body).map((id): DatasetFact => {
    const builtin = /^builtin:(.+)$/.exec(id)
    if (builtin) return { id, name: builtinTable(builtin[1])?.label ?? builtin[1], store: 'local', origin: { kind: 'builtin', table: builtin[1] } }
    const out = /^transform:(\d+)(?:\.(\d+))?$/.exec(id)
    const t = out ? transforms[Number(out[1])] : undefined
    const output = t?.outputs[Number(out?.[2] ?? 0)]
    if (t && output) return { id, name: output.name, store: 'local', origin: { kind: 'output', transform: t.id, output: output.key } }
    return { id, name: isStr(names[id]) ? names[id] : 'Unnamed dataset', store: 'local', origin: { kind: 'unknown' } }
  })
  return {
    ok: true,
    file: {
      format: FILE_FORMAT,
      version: FILE_VERSION,
      ...(isStr(o.exportedAt) ? { exportedAt: o.exportedAt } : {}),
      ...(isStr(o.workspaceId) ? { workspaceId: o.workspaceId } : {}),
      name: o.name,
      ...body,
      datasets,
      ...(Array.isArray(o.requires) && o.requires.every(isStr) && o.requires.length ? { requires: o.requires } : {}),
    },
  }
}

/** The document with dataset ids swapped where `to` knows them (others unchanged): pointers and facts alike. */
export function replaceDatasetIds(file: WorkspaceFile, to: (id: string) => string | undefined): WorkspaceFile {
  const r = (p: string) => to(p) ?? p
  return {
    ...file,
    datasetIds: file.datasetIds.map(r),
    datasets: file.datasets.map((d) => ({ ...d, id: r(d.id) })),
    visualizations: file.visualizations.map((v) => ({ ...v, datasetId: r(v.datasetId) })),
    transforms: file.transforms.map((t) => ({
      ...t,
      inputs: t.inputs.map((i) => ({ ...i, datasetId: r(i.datasetId) })),
      outputs: t.outputs.map((o) => (o.outputId ? { ...o, outputId: r(o.outputId) } : o)),
    })),
  }
}

/**
 * The working copy a document describes, keeping the current workspace's id (a
 * loaded document replaces its contents) and giving visualizations and
 * transforms fresh ids so they never collide with another workspace's
 * records. Datasets missing from the database are dropped, with what depends
 * on them, and reported.
 */
export function fromWorkspaceFile(
  file: WorkspaceFile,
  current: WorkspaceDoc,
  inDatabase: (id: string) => boolean,
): { doc: WorkspaceDoc; missing: string[]; droppedVisualizations: string[]; droppedTransforms: string[] } {
  const missing = file.datasetIds.filter((id) => !inDatabase(id))
  const datasetIds = file.datasetIds.filter((id) => inDatabase(id))
  const vizOk = (v: VisualizationSpec) => datasetIds.includes(v.datasetId) && isSupportedBinding(v.binding) // older files had lat/lon pairs
  const visualizations = file.visualizations.filter(vizOk).map((v) => ({ ...v, id: newId() }))
  // Transforms need all their inputs here; an output pointer to a missing dataset is dropped (it's made anew on Run).
  const tOk = (t: TransformSpec) => t.inputs.every((i) => datasetIds.includes(i.datasetId))
  const transforms = file.transforms
    .filter(tOk)
    .map((t) => ({ ...t, id: newId(), outputs: t.outputs.map((o) => (o.outputId && !inDatabase(o.outputId) ? { ...o, outputId: undefined } : o)) }))
  return {
    doc: { ...(current.id ? { id: current.id } : {}), name: file.name, datasetIds, visualizations, transforms },
    missing,
    droppedVisualizations: file.visualizations.filter((v) => !datasetIds.includes(v.datasetId)).map((v) => v.name),
    droppedTransforms: file.transforms.filter((t) => !tOk(t)).map((t) => t.name),
  }
}

// ── reports ────────────────────────────────────────────────────────────────

/** A dataset a device couldn't use, and why (`openDocument` on the server). */
export interface MissingDataset {
  id: string
  name: string
  rows?: number
  why: 'elsewhere' | 'cloud' | 'unknown' | 'builtin' | 'output'
}

const WHY: Record<MissingDataset['why'], [string, string]> = {
  elsewhere: ['uploaded on another device and kept only there', 'uploaded on another device and kept only there'],
  cloud: ["in the cloud but not reachable here", "in the cloud but not reachable here"],
  unknown: ['not on this device', 'not on this device'],
  builtin: ["a built-in table this version of the app doesn't have", "built-in tables this version of the app doesn't have"],
  output: ["made by a transform that couldn't run", "made by transforms that couldn't run"],
}

/** What of an opened workspace isn't on this device, line by line: datasets by name and why, transforms that couldn't run and why, and what was left out with them. */
export function missingReport(missing: MissingDataset[], failed: { name: string; reason: string }[], vizs: string[], transforms: string[]): string {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  const list = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ')
  const lines: string[] = []
  for (const why of ['elsewhere', 'cloud', 'unknown', 'builtin'] as const) {
    const ds = missing.filter((m) => m.why === why)
    if (!ds.length) continue
    const [one, many] = WHY[why]
    lines.push(`• ${n(ds.length, 'dataset')} ${ds.length === 1 ? one : many}: ${ds.map((d) => `"${d.name}"${d.rows !== undefined ? ` (${d.rows.toLocaleString()} rows)` : ''}`).join(', ')}.`)
  }
  if (failed.length) lines.push(`• ${n(failed.length, "transform that couldn't run", "transforms that couldn't run")}: ${failed.map((f) => `"${f.name}" (${f.reason})`).join(', ')}.`)
  const failedNames = new Set(failed.map((f) => f.name))
  const otherTransforms = transforms.filter((t) => !failedNames.has(t))
  const leftOut = [vizs.length ? `${n(vizs.length, 'visualization')} (${list(vizs)})` : '', otherTransforms.length ? `${n(otherTransforms.length, 'transform')} (${list(otherTransforms)})` : ''].filter(Boolean)
  if (leftOut.length) lines.push(`• Left out with them: ${leftOut.join(' and ')}.`)
  if (missing.some((m) => m.why === 'elsewhere')) lines.push('Datasets uploaded on another device stay there; storing datasets in the cloud comes next.')
  return lines.join('\n')
}

/** A short, readable summary of a document: one line per item (the cloud's `overview` column; overview.md in files). */
export function overviewOf(file: WorkspaceFile): string {
  const fact = new Map(file.datasets.map((d) => [d.id, d]))
  const ds = (id: string) => `"${fact.get(id)?.name ?? id}"`
  const origin = (d: DatasetFact) =>
    d.origin.kind === 'builtin' ? 'built-in' : d.origin.kind === 'output' ? `output of "${file.transforms.find((t) => t.id === (d.origin as { transform: string }).transform)?.name ?? '?'}"` : d.origin.kind === 'upload' ? `uploaded (${d.origin.source})` : 'origin unknown'
  const lines = [`# Workspace "${file.name}"`, '', `## Datasets (${file.datasetIds.length})`]
  for (const id of file.datasetIds) {
    const d = fact.get(id)
    lines.push(d ? `- ${d.name} · ${d.store === 'remote' ? 'Cloud' : 'Local'}${d.rows !== undefined ? ` · ${d.rows.toLocaleString()} rows` : ''} · ${origin(d)}` : `- ${id}`)
  }
  lines.push('', `## Transforms (${file.transforms.length})`)
  for (const t of file.transforms) lines.push(`- ${t.name}: ${t.inputs.map((i) => `${i.alias} = ${ds(i.datasetId)}`).join(', ')} → ${t.outputs.map((o) => (o.outputId ? ds(o.outputId) : `"${o.name}" (not run yet)`)).join(', ')}`)
  lines.push('', `## Visualizations (${file.visualizations.length}; the first draws on top)`)
  for (const v of file.visualizations) lines.push(`- ${v.name}: ${ds(v.datasetId)} · ${v.column} (${v.aggregation})${v.visible ? '' : ' · hidden'}`)
  return lines.join('\n')
}

// ── drafts ─────────────────────────────────────────────────────────────────

/** Stable text of what Save would store — equal text means nothing to save. */
export function snapshot(doc: WorkspaceDoc): string {
  return JSON.stringify({ name: doc.name, datasetIds: doc.datasetIds, visualizations: doc.visualizations, transforms: doc.transforms })
}

/** Unsaved edits kept on the device between visits. */
export interface Draft {
  doc: WorkspaceDoc
  /** Snapshot of the workspace as last saved (to tell whether the draft differs). */
  saved: string
}

export function parseDraft(text: string | null): Draft | null {
  if (!text) return null
  try {
    const d = JSON.parse(text) as Draft
    if (!(d && typeof d.saved === 'string' && d.doc && Array.isArray(d.doc.datasetIds) && Array.isArray(d.doc.visualizations))) return null
    return { ...d, doc: { ...d.doc, transforms: (d.doc.transforms ?? []).map((t) => normalizeTransform(t)) } } // older drafts: no transforms, or single-SQL ones
  } catch {
    return null
  }
}

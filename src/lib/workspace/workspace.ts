// The workspace document: everything a user (or, later, an agent) has set
// up — datasets and the ordered visualizations — as one plain, serializable
// object. Every change goes through the operations below, which return
// either the new document or an error an agent can read and act on.
// Datasets' rows aren't in the document: built-in tables are referenced,
// imported ones are stored on the device under the dataset's id.

import type { GeometryBinding } from '../dataset/binding'
import type { VisualizationSpec } from '../dataset/visualization'

export const WORKSPACE_VERSION = 1

/** Where a dataset's rows come from when the workspace is reopened. */
export type RowsRef =
  /** A built-in table, re-read on load (picks up data updates). */
  | { kind: 'builtin'; table: string }
  /** Rows stored on this device under the dataset's id. */
  | { kind: 'stored' }

/** Standard dataset metadata. Features attach their own under `extensions`. */
export interface DatasetMeta {
  description?: string
  createdAt: string
  updatedAt: string
  extensions?: Record<string, unknown>
}

/** A vector column built from two numeric columns at import, re-applied on load. */
export interface VectorColumnSpec {
  name: string
  u: string
  v: string
}

export interface DatasetEntry {
  id: string
  name: string
  binding: GeometryBinding
  /** Where the rows came from, for display ("Device · plants.csv"). */
  origin: string
  rows: RowsRef
  vectorColumns?: VectorColumnSpec[]
  /** Dataset-specific app extras (custom dashboard, search). */
  preset?: 'utilities'
  meta: DatasetMeta
}

export interface WorkspaceDoc {
  version: typeof WORKSPACE_VERSION
  datasets: DatasetEntry[]
  /** Top of the list draws on top. */
  visualizations: VisualizationSpec[]
}

export interface OpError {
  code: 'not_found' | 'duplicate' | 'invalid'
  message: string
}
export type OpResult = { ok: true; doc: WorkspaceDoc } | { ok: false; error: OpError }

const ok = (doc: WorkspaceDoc): OpResult => ({ ok: true, doc })
const fail = (code: OpError['code'], message: string): OpResult => ({ ok: false, error: { code, message } })

/** Optional knowledge of datasets' columns, so visualization ops can be validated. */
export interface OpContext {
  columns?: (datasetId: string) => string[] | undefined
}

export const emptyWorkspace = (): WorkspaceDoc => ({ version: WORKSPACE_VERSION, datasets: [], visualizations: [] })

const now = () => new Date().toISOString()

// ── datasets ───────────────────────────────────────────────────────────────

export function addDataset(doc: WorkspaceDoc, entry: DatasetEntry, visualizations: VisualizationSpec[] = []): OpResult {
  if (!entry.name.trim()) return fail('invalid', 'A dataset needs a name')
  if (doc.datasets.some((d) => d.id === entry.id)) return fail('duplicate', `Dataset id "${entry.id}" already exists`)
  const foreign = visualizations.find((v) => v.datasetId !== entry.id)
  if (foreign) return fail('invalid', `Visualization "${foreign.name}" doesn't belong to dataset "${entry.id}"`)
  // New datasets go to the end; their visualizations go on top (and draw on top).
  return ok({ ...doc, datasets: [...doc.datasets, entry], visualizations: [...visualizations, ...doc.visualizations] })
}

export function updateDataset(
  doc: WorkspaceDoc,
  id: string,
  patch: { name?: string; description?: string; extensions?: Record<string, unknown> },
): OpResult {
  const i = doc.datasets.findIndex((d) => d.id === id)
  if (i < 0) return fail('not_found', `No dataset "${id}"`)
  if (patch.name !== undefined && !patch.name.trim()) return fail('invalid', 'A dataset needs a name')
  const d = doc.datasets[i]
  const meta: DatasetMeta = {
    ...d.meta,
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.extensions !== undefined ? { extensions: { ...d.meta.extensions, ...patch.extensions } } : {}),
    updatedAt: now(),
  }
  const datasets = [...doc.datasets]
  datasets[i] = { ...d, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), meta }
  return ok({ ...doc, datasets })
}

/** Removes the dataset and every visualization of it. */
export function removeDataset(doc: WorkspaceDoc, id: string): OpResult {
  if (!doc.datasets.some((d) => d.id === id)) return fail('not_found', `No dataset "${id}"`)
  return ok({ ...doc, datasets: doc.datasets.filter((d) => d.id !== id), visualizations: doc.visualizations.filter((v) => v.datasetId !== id) })
}

function reorder<T extends { id: string }>(items: T[], ids: string[], what: string): T[] | OpError {
  const byId = new Map(items.map((x) => [x.id, x]))
  if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
    return { code: 'invalid', message: `Reorder must list every ${what} exactly once (${items.length} expected)` }
  }
  return ids.map((id) => byId.get(id)!)
}

export function reorderDatasets(doc: WorkspaceDoc, ids: string[]): OpResult {
  const r = reorder(doc.datasets, ids, 'dataset')
  return Array.isArray(r) ? ok({ ...doc, datasets: r }) : { ok: false, error: r }
}

// ── visualizations ─────────────────────────────────────────────────────────

function checkVisualization(doc: WorkspaceDoc, v: VisualizationSpec, ctx: OpContext): OpError | null {
  if (!doc.datasets.some((d) => d.id === v.datasetId)) return { code: 'not_found', message: `No dataset "${v.datasetId}"` }
  if (!v.name.trim()) return { code: 'invalid', message: 'A visualization needs a name' }
  const cols = ctx.columns?.(v.datasetId)
  if (cols && v.column !== '__rows' && !cols.includes(v.column)) {
    return { code: 'not_found', message: `Dataset "${v.datasetId}" has no column "${v.column}" (has: ${cols.join(', ')})` }
  }
  return null
}

/** Adds at `position` (0 = top, the default). */
export function addVisualization(doc: WorkspaceDoc, v: VisualizationSpec, position = 0, ctx: OpContext = {}): OpResult {
  if (doc.visualizations.some((x) => x.id === v.id)) return fail('duplicate', `Visualization id "${v.id}" already exists`)
  const err = checkVisualization(doc, v, ctx)
  if (err) return { ok: false, error: err }
  const list = [...doc.visualizations]
  list.splice(Math.max(0, Math.min(position, list.length)), 0, v)
  return ok({ ...doc, visualizations: list })
}

export function updateVisualization(doc: WorkspaceDoc, v: VisualizationSpec, ctx: OpContext = {}): OpResult {
  const i = doc.visualizations.findIndex((x) => x.id === v.id)
  if (i < 0) return fail('not_found', `No visualization "${v.id}"`)
  const err = checkVisualization(doc, v, ctx)
  if (err) return { ok: false, error: err }
  const list = [...doc.visualizations]
  list[i] = v
  return ok({ ...doc, visualizations: list })
}

export function removeVisualization(doc: WorkspaceDoc, id: string): OpResult {
  if (!doc.visualizations.some((v) => v.id === id)) return fail('not_found', `No visualization "${id}"`)
  return ok({ ...doc, visualizations: doc.visualizations.filter((v) => v.id !== id) })
}

/** `ids` top first. */
export function reorderVisualizations(doc: WorkspaceDoc, ids: string[]): OpResult {
  const r = reorder(doc.visualizations, ids, 'visualization')
  return Array.isArray(r) ? ok({ ...doc, visualizations: r }) : { ok: false, error: r }
}

// ── serialization ──────────────────────────────────────────────────────────

export function serializeWorkspace(doc: WorkspaceDoc): string {
  return JSON.stringify(doc)
}

/** Parses a saved workspace; rejects anything that isn't one (including other versions). */
export function parseWorkspace(text: string): { ok: true; doc: WorkspaceDoc } | { ok: false; error: OpError } {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return { ok: false, error: { code: 'invalid', message: 'Saved workspace is not valid JSON' } }
  }
  const d = o as Partial<WorkspaceDoc>
  if (!d || d.version !== WORKSPACE_VERSION || !Array.isArray(d.datasets) || !Array.isArray(d.visualizations)) {
    return { ok: false, error: { code: 'invalid', message: `Not a version-${WORKSPACE_VERSION} workspace` } }
  }
  const ids = new Set(d.datasets.map((x) => x.id))
  // Drop visualizations whose dataset is gone rather than failing the whole load.
  return { ok: true, doc: { version: WORKSPACE_VERSION, datasets: d.datasets, visualizations: d.visualizations.filter((v) => ids.has(v.datasetId)) } }
}

export function newDatasetMeta(description?: string): DatasetMeta {
  const t = now()
  return { ...(description ? { description } : {}), createdAt: t, updatedAt: t }
}

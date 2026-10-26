// The client's working copy of a workspace: dataset pointers, the ordered
// visualizations and the transforms (SQL that makes datasets). Every edit
// goes through the operations below, which return the new document or an
// error an agent can read and act on. The server stores it (saveWorkspace)
// as a config of pointers plus visualization and transform records; rows
// never live here — datasets are tables in the database.

import type { VisualizationSpec } from '../dataset/visualization'

export interface WorkspaceDoc {
  /** Server id once saved. */
  id?: string
  name: string
  datasetIds: string[]
  /** Top of the list draws on top. */
  visualizations: VisualizationSpec[]
  transforms: TransformSpec[]
}

/** A SQL query over input datasets (each called by an alias in the SQL); running it writes `outputId`, or a new dataset. */
export interface TransformSpec {
  id: string
  name: string
  sql: string
  inputs: { datasetId: string; alias: string }[]
  outputId?: string
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

export const emptyWorkspace = (name = 'My workspace'): WorkspaceDoc => ({ name, datasetIds: [], visualizations: [], transforms: [] })

// ── datasets (pointers) ────────────────────────────────────────────────────

/** Adds a dataset to the workspace (at the end); its visualizations go on top. */
export function addDataset(doc: WorkspaceDoc, datasetId: string, visualizations: VisualizationSpec[] = []): OpResult {
  if (doc.datasetIds.includes(datasetId)) return fail('duplicate', `Dataset "${datasetId}" is already in the workspace`)
  const foreign = visualizations.find((v) => v.datasetId !== datasetId)
  if (foreign) return fail('invalid', `Visualization "${foreign.name}" doesn't belong to dataset "${datasetId}"`)
  return ok({ ...doc, datasetIds: [...doc.datasetIds, datasetId], visualizations: [...visualizations, ...doc.visualizations] })
}

/** Takes a dataset (and its visualizations) out of the workspace. The dataset itself stays in the database. */
export function removeDataset(doc: WorkspaceDoc, datasetId: string): OpResult {
  if (!doc.datasetIds.includes(datasetId)) return fail('not_found', `No dataset "${datasetId}" in the workspace`)
  const user = doc.transforms.find((t) => t.inputs.some((i) => i.datasetId === datasetId))
  if (user) return fail('invalid', `Transform "${user.name}" uses this dataset as an input — remove it from the transform first`)
  return ok({ ...doc, datasetIds: doc.datasetIds.filter((d) => d !== datasetId), visualizations: doc.visualizations.filter((v) => v.datasetId !== datasetId) })
}

function sameSet(ids: string[], current: string[]): boolean {
  return ids.length === current.length && new Set(ids).size === ids.length && ids.every((id) => current.includes(id))
}

export function reorderDatasets(doc: WorkspaceDoc, ids: string[]): OpResult {
  if (!sameSet(ids, doc.datasetIds)) return fail('invalid', `Reorder must list every dataset exactly once (${doc.datasetIds.length} expected)`)
  return ok({ ...doc, datasetIds: [...ids] })
}

export function renameWorkspace(doc: WorkspaceDoc, name: string): OpResult {
  if (!name.trim()) return fail('invalid', 'A workspace needs a name')
  return ok({ ...doc, name: name.trim() })
}

// ── visualizations ─────────────────────────────────────────────────────────

function checkVisualization(doc: WorkspaceDoc, v: VisualizationSpec, ctx: OpContext): OpError | null {
  if (!doc.datasetIds.includes(v.datasetId)) return { code: 'not_found', message: `No dataset "${v.datasetId}" in the workspace` }
  if (!v.name.trim()) return { code: 'invalid', message: 'A visualization needs a name' }
  const cols = ctx.columns?.(v.datasetId)
  if (cols) {
    const used = [v.column, v.binding.column].filter((c) => c !== '__rows')
    const missing = used.find((c) => !cols.includes(c))
    if (missing) return { code: 'not_found', message: `Dataset "${v.datasetId}" has no column "${missing}" (has: ${cols.join(', ')})` }
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
  const current = doc.visualizations.map((v) => v.id)
  if (!sameSet(ids, current)) return fail('invalid', `Reorder must list every visualization exactly once (${current.length} expected)`)
  const byId = new Map(doc.visualizations.map((v) => [v.id, v]))
  return ok({ ...doc, visualizations: ids.map((id) => byId.get(id)!) })
}

// ── transforms ─────────────────────────────────────────────────────────────

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/

function checkTransform(doc: WorkspaceDoc, t: TransformSpec): OpError | null {
  if (!t.name.trim()) return { code: 'invalid', message: 'A transform needs a name' }
  if (!t.inputs.length) return { code: 'invalid', message: 'A transform needs at least one input dataset' }
  for (const i of t.inputs) {
    if (!doc.datasetIds.includes(i.datasetId)) return { code: 'not_found', message: `Input dataset "${i.datasetId}" isn't in the workspace` }
    if (!ALIAS.test(i.alias)) return { code: 'invalid', message: `"${i.alias}" can't be a table name: use letters, digits and _ (not starting with a digit)` }
  }
  const aliases = t.inputs.map((i) => i.alias)
  const dup = aliases.find((a, i) => aliases.indexOf(a) !== i)
  if (dup) return { code: 'invalid', message: `Two inputs are both called "${dup}"` }
  if (t.outputId) {
    if (t.inputs.some((i) => i.datasetId === t.outputId)) return { code: 'invalid', message: "A transform can't write one of its own inputs" }
    const other = doc.transforms.find((x) => x.id !== t.id && x.outputId === t.outputId)
    if (other) return { code: 'invalid', message: `That dataset is already written by transform "${other.name}"` }
  }
  return null
}

export function addTransform(doc: WorkspaceDoc, t: TransformSpec): OpResult {
  if (doc.transforms.some((x) => x.id === t.id)) return fail('duplicate', `Transform id "${t.id}" already exists`)
  const err = checkTransform(doc, t)
  return err ? { ok: false, error: err } : ok({ ...doc, transforms: [...doc.transforms, t] })
}

export function updateTransform(doc: WorkspaceDoc, t: TransformSpec): OpResult {
  const i = doc.transforms.findIndex((x) => x.id === t.id)
  if (i < 0) return fail('not_found', `No transform "${t.id}"`)
  const err = checkTransform(doc, t)
  if (err) return { ok: false, error: err }
  const transforms = [...doc.transforms]
  transforms[i] = t
  return ok({ ...doc, transforms })
}

/** Removes the transform; the dataset it wrote stays. */
export function removeTransform(doc: WorkspaceDoc, id: string): OpResult {
  if (!doc.transforms.some((t) => t.id === id)) return fail('not_found', `No transform "${id}"`)
  return ok({ ...doc, transforms: doc.transforms.filter((t) => t.id !== id) })
}

/** A table name for a dataset's name: lowercase words joined by _. */
export function aliasFor(name: string): string {
  const a = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[a-z_]/.test(a) ? a.slice(0, 40) : `t_${a}`.slice(0, 40)
}

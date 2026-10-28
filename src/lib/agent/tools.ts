// The agent's tools: what the model may call, checked before anything runs.
// Each tool validates its input, applies the store gate (agents change only
// local datasets), and calls an operation the UI already uses through the
// host. No business logic lives here (docs/agents.md).

import type { ApiResult } from '../../shared/api'
import { storeOf, type DatasetRecord, type TransformInputRef } from '../../shared/records'
import type { ColumnInfo } from '../dataset/columns'
import { isGeometryColumn } from '../dataset/columns'
import type { DataRecord } from '../data/connectors'
import { aggregationsFor, defaultAggregation, type Aggregation } from '../dataset/aggregate'
import type { GeometryBinding } from '../dataset/binding'
import type { BindingInfo, VizValues } from '../dataset/query'
import { columnType, makeVisualization, retarget, ROWS, VALUE, type VisualizationSpec } from '../dataset/visualization'
import { newId } from '../dataset/dataset'
import { COLORMAPS, type ColormapName } from '../colormaps'
import type { PaletteName } from '../palettes'
import { MAGNITUDE_FIELD, type ColorEncoding } from '../style'
import { addDataset, addTransform, addVisualization, newOutput, type OpContext, type TransformSpec, type WorkspaceDoc } from '../workspace/workspace'
import { transformState } from '../workspace/dag'
import { snapshot } from '../workspace/file'
import type { ToolOutcome } from './loop'
import { agentColor, agentTransform, agentVisualization, assembleFiles, canonical, EDITOR_TOOL, OVERVIEW, overviewText, runEditor, sqlPath, transformPath, vizPath, workspaceFiles, type Files } from './workspaceFiles'
import type { ToolSpec } from './provider'

/** What the tools act through: the page's workspace copy and the server. */
export interface AgentHost {
  doc(): WorkspaceDoc
  setDoc(doc: WorkspaceDoc): void
  dataset(id: string): Promise<DatasetRecord | undefined>
  /** Every dataset the user can use, local and remote (the app's dataset finder). */
  listDatasets(): Promise<DatasetRecord[]>
  query(sql: string, inputs: TransformInputRef[], limit: number): Promise<ApiResult<{ columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number }>>
  /** How a dataset looks under a geometry binding, or an error message. */
  shape(datasetId: string, binding: GeometryBinding): Promise<BindingInfo | string>
  /** The values a visualization draws, one per feature (what the map colors), or an error message. */
  values(datasetId: string, binding: GeometryBinding, column: string, aggregation: Aggregation): Promise<VizValues | string>
  runTransform(id: string): Promise<{ ok: true; outputs: { datasetId: string; name: string; rowCount: number; created: boolean }[] } | { ok: false; message: string }>
  deleteDataset(id: string): Promise<{ ok: true } | { ok: false; message: string }>
  /** Renames or describes a dataset (its rows are untouched). */
  updateDataset(id: string, patch: { name?: string; description?: string }): Promise<{ ok: true } | { ok: false; message: string }>
  /** Shows the user a question (and optional details) with Approve / Reject and a notes box; resolves with their answer. */
  ask(question: string, details?: string): Promise<UserAnswer>
}

export interface UserAnswer {
  answer: 'approve' | 'reject'
  notes?: string
}

const PALETTES: PaletteName[] = ['auto', 'p12', 'p24', 'p60', 'many']
const AGG_NAMES = ['first', 'count', 'distinct', 'sum', 'mean', 'min', 'max', 'mode', 'any']
export const QUERY_LIMIT = 50

// ── tool definitions ───────────────────────────────────────────────────────

export const TOOLS: ToolSpec[] = [
  {
    name: 'get_workspace',
    description:
      "Where to start, and how to see the user's changes: (re)builds the workspace files you edit with the text editor (discarding edits you haven't applied) and returns /overview.md — every dataset, transform and visualization with its id, one line each. The files: /workspace.json (name, datasetIds, transform ids, visualization ids in draw order), /transforms/<id>.json (name, inputs, outputs), /transforms/<id>.<output key>.sql (that output's SQL, plain), /visualizations/<id>.json. View only the files you need.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_datasets',
    description:
      "Every dataset the user can use, including those outside the workspace, local and cloud: id, name, description, store, origin, row count, inWorkspace. Use it only when the workspace doesn't hold what the request needs, and after asking the user (ask_user) whether to look beyond the workspace.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ask_user',
    description:
      "Ask the user to approve or reject something, and wait for the answer. Shows your question (and optional details, such as the datasets you found relevant and your plan) with Approve / Reject buttons and a notes box. Returns {answer: 'approve' | 'reject', notes}. Use it to confirm a plan before building, and before looking outside the workspace. For an open question, ask in plain text and end your turn instead.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One short question, answerable with approve / reject.' },
        details: { type: 'string', description: 'Optional: what you found and what you propose, in a few short lines.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'query_sql',
    description:
      'Run one read-only SELECT (DuckDB) over datasets and get the first rows plus the total row count. Nothing is stored. Each input dataset is a table named by its alias. Geometry cells come back as "<region>" etc. Use it to profile (FROM (SUMMARIZE t)), check values and join coverage, and test transform SQL before writing it. CTEs (WITH …) chain steps. Spatial functions (ST_…) work: the engine loads its spatial extension on first use. Works on any dataset, local or remote, in the workspace or not.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        inputs: {
          type: 'array',
          items: { type: 'object', properties: { datasetId: { type: 'string' }, alias: { type: 'string' } }, required: ['datasetId', 'alias'] },
        },
        limit: { type: 'integer', description: `Rows to return, at most ${QUERY_LIMIT} (default 20).` },
      },
      required: ['sql', 'inputs'],
    },
  },
  {
    name: EDITOR_TOOL,
    builtin: 'text_editor',
    // Not sent to Claude: Anthropic's editor brings its own definition. The file layout is taught in
    // overview.md (get_workspace) and the prompt. Other providers would see this.
    description: 'View and edit the workspace files: view (a file, or / for the list), create, str_replace (text that occurs once), insert. Changes nothing until apply_workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
        path: { type: 'string', description: 'e.g. /workspace.json, /transforms/<id>.json' },
        file_text: { type: 'string', description: 'create: the whole file.' },
        old_str: { type: 'string', description: 'str_replace: exact text that occurs once.' },
        new_str: { type: 'string', description: 'str_replace: the replacement.' },
        insert_line: { type: 'integer', description: 'insert: the line to insert after (0 = the start).' },
        insert_text: { type: 'string', description: 'insert: the text.' },
        view_range: { type: 'array', items: { type: 'integer' }, description: 'view: [first line, last line] (-1 = the end).' },
      },
      required: ['command', 'path'],
    },
  },
  {
    name: 'apply_workspace',
    description: [
      "Make your edits to the workspace files the workspace (the user's unsaved draft: they Save or Discard it). Everything is checked together; nothing changes if anything is wrong, and every problem is listed with its file.",
      'How the files work: an item exists when its id is listed in /workspace.json (transforms; visualizations, whose order is draw order, first on top); its file is /transforms/<id>.json or /visualizations/<id>.json, and the file name is the id. To add an item, create its file under a short name you choose (e.g. by_state) and add that name to the list; it gets a real id when applied (the reply says which). To remove one, take its id out of the list. Datasets join the workspace through "datasetIds".',
      'Transforms: {"name", "inputs": [{"datasetId", "alias"}], "outputs": [{"key", "name", "outputId"?}]}; each output\'s SQL is the plain file /transforms/<id>.<key>.sql (never SQL inside JSON). Leave outputId out for a new output: it writes a new dataset on its first run. A new or changed transform does nothing until run_transform.',
      `Visualizations: {"name", "datasetId", "geometry" (a point / polyline / region column), "label"? (a column naming each feature), "column" (or "${ROWS}"), "aggregation"? (${AGG_NAMES.join(', ')}), "visible"?, "color"?, "opacity"? (0–1)}; color: {"kind": "colormap", "colormap", "reverse"?, "scale"? ("linear" / "log"), "domain"? ([min, max])} | {"kind": "categorical", "palette"?} | {"kind": "constant", "color": "#rrggbb"}. Items you didn't edit stay exactly as they are.`,
      'dryRun: check and describe the change without applying it. Refused if the user changed the workspace since get_workspace, or if a transform would write a cloud dataset.',
    ].join('\n\n'),
    inputSchema: {
      type: 'object',
      properties: { dryRun: { type: 'boolean', description: 'Check and describe the change without applying it.' } },
    },
  },
  {
    name: 'visualization_stats',
    description:
      'How the values a visualization draws are distributed: one value per feature, after the aggregation (which can differ from the raw rows). Numbers: count, nulls, min, percentiles, max, mean, how many are ≤ 0 and < 0, and how many orders of magnitude the positive values span. Text: distinct values and the most common. Use it after adding or changing a visualization to choose the scale (linear / log), colormap (sequential / diverging) and domain.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'run_transform',
    description:
      'Run one transform of the workspace (its current SQL): every output is written, or none if any SQL fails. New output datasets join the workspace (without visualizations). Returns row counts and dataset ids. Refused if an output would write a cloud dataset.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'update_dataset',
    description:
      "Rename a local dataset and/or set its description (its rows don't change). Refused for cloud datasets. Give datasets you create a clear name and a one-line description (what each row is, the source, the period), so they're easy to find later.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'delete_dataset',
    description:
      'Delete a local dataset and its rows for good (and its visualizations). Refused for cloud datasets, and while a workspace transform reads it. Use it to clean up datasets you made that are no longer needed.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
]

// ── helpers ────────────────────────────────────────────────────────────────

/** A short stamp of the workspace's contents (changes whenever anything does). */
export function workspaceVersion(doc: WorkspaceDoc): string {
  let h = 0x811c9dc5
  const s = snapshot(doc)
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const optStr = (v: unknown) => v === undefined || str(v)

class Invalid extends Error {}
function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Invalid(message)
}

const ok = (data: unknown, summary: string): ToolOutcome => ({ content: JSON.stringify(data), isError: false, summary })
const err = (message: string, summary = message): ToolOutcome => ({ content: message, isError: true, summary })
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`
/** The store as users call it: local (this device) or cloud. */
const storeLabel = (d: DatasetRecord) => (storeOf(d) === 'remote' ? 'cloud' : 'local')
const columnsOf = (cols: ColumnInfo[]) => cols.map((c) => `${c.name} ${c.type}`).join(', ')

/** A cell as the model sees it: geometry as its type, long text cut. */
function cell(v: unknown, type: string | undefined): unknown {
  if (v === null || v === undefined) return null
  if (type && isGeometryColumn(type as ColumnInfo['type'])) return `<${type}>`
  if (typeof v === 'string') {
    if (/^\s*\{"type":"(Multi)?(Point|LineString|Polygon)"/.test(v)) return '<geometry>'
    return v.length > 200 ? `${v.slice(0, 200)}…` : v
  }
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 200 ? `${s.slice(0, 200)}…` : v
  }
  return v
}

// ── list_datasets / get_workspace ──────────────────────────────────────────

async function listDatasets(host: AgentHost): Promise<ToolOutcome> {
  const inWorkspace = new Set(host.doc().datasetIds)
  const all = await host.listDatasets()
  const data = all.map((d) => ({
    id: d.id,
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    store: storeLabel(d),
    origin: d.origin,
    rows: d.rowCount,
    inWorkspace: inWorkspace.has(d.id),
  }))
  return ok(data, `${plural(data.length, 'dataset')} (${data.filter((d) => d.store === 'local').length} local)`)
}

// ── the workspace files ────────────────────────────────────────────────────

/**
 * The files the agent edits, per chat host: built from the draft at
 * get_workspace (and whenever they hold no pending edits and the draft
 * moved on); `base` is the draft version they were built from.
 */
interface Staging {
  files: Files
  base: string
  dirty: boolean
}
const staging = new WeakMap<AgentHost, Staging>()
/** Files an apply renamed (a new item's placeholder name → its id), per host: old path → what it became. */
const renames = new WeakMap<AgentHost, Map<string, { path: string; kind: string; id: string }>>()

/** The host's files, rebuilt from the draft when nothing is pending and the draft changed. */
function staged(host: AgentHost, fresh = false): Staging {
  const version = workspaceVersion(host.doc())
  const s = staging.get(host)
  if (s && !fresh && (s.dirty || s.base === version)) return s
  const next = { files: workspaceFiles(host.doc()), base: version, dirty: false }
  staging.set(host, next)
  return next
}

/** A refusal while edits are pending: tools that change the draft would act on the old version. */
function pendingEdits(host: AgentHost): ToolOutcome | null {
  return staging.get(host)?.dirty ? err('You have edits to the workspace files that are not applied. Call apply_workspace first (or get_workspace to discard them).', 'refused: edits not applied') : null
}

async function renderOverview(host: AgentHost, s: Staging): Promise<string> {
  const doc = host.doc()
  // States need the outputs' records too, which may sit outside the workspace.
  const byId = new Map((await host.listDatasets()).map((d) => [d.id, d]))
  return overviewText(s.files, doc, {
    version: s.base,
    pending: s.dirty,
    datasets: [...byId.values()].map((d) => ({ id: d.id, name: d.name, store: storeLabel(d), rows: d.rowCount, origin: d.origin, ...(d.description ? { description: d.description } : {}) })),
    state: (id) => {
      const t = doc.transforms.find((x) => x.id === id)
      return t ? transformState(t, (x) => byId.get(x)) : undefined
    },
  })
}

async function getWorkspace(host: AgentHost): Promise<ToolOutcome> {
  const discarded = staging.get(host)?.dirty
  const s = staged(host, true)
  const doc = host.doc()
  const text = `${discarded ? '(Your edits that were not applied have been discarded.)\n\n' : ''}${await renderOverview(host, s)}`
  return { content: text, isError: false, summary: `${plural(doc.datasetIds.length, 'dataset')} · ${plural(doc.transforms.length, 'transform')} · ${plural(doc.visualizations.length, 'visualization')}` }
}

async function editor(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  const s = staged(host)
  let overview = ''
  // overview.md is rendered from the files as they are (async: it reads dataset records).
  if (input.command === 'view' && String(input.path ?? '').replace(/^\/+/, '') === OVERVIEW) overview = await renderOverview(host, s)
  // A file an apply renamed: say where it went (a fact this session recorded), not just "missing".
  const key = String(input.path ?? '').replace(/^\/+/, '')
  const moved = input.command !== 'create' && !s.files.has(key) ? renames.get(host)?.get(key) : undefined
  if (moved) {
    return err(`/${key} was applied as ${moved.kind} ${moved.id}; its file is now /${moved.path}. Applying rewrites files in the standard format, so view it before editing.`, `${input.command ?? 'edit'}: file renamed`)
  }
  const r = runEditor(s.files, input, () => overview)
  if (!r.ok) return err(r.error, `${input.command ?? 'edit'}: refused`)
  if (r.changed) s.dirty = true
  const path = String(input.path ?? '/')
  const summary = input.command === 'view' ? `viewed ${path}` : `${input.command === 'create' ? 'wrote' : 'edited'} ${path}`
  return { content: r.text, isError: false, summary }
}

// ── query_sql ──────────────────────────────────────────────────────────────

function readInputs(v: unknown): TransformInputRef[] {
  need(Array.isArray(v), '`inputs` must be a list of {datasetId, alias}')
  return v.map((i, n) => {
    need(isObj(i) && str(i.datasetId) && str(i.alias), `inputs[${n}] needs datasetId and alias`)
    return { datasetId: i.datasetId, alias: i.alias }
  })
}

async function querySql(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.sql) && input.sql.trim(), '`sql` must be a SELECT')
  const inputs = readInputs(input.inputs)
  for (const i of inputs) need(await host.dataset(i.datasetId), `No dataset "${i.datasetId}"`)
  const limit = Math.max(1, Math.min(QUERY_LIMIT, Number.isInteger(input.limit) ? (input.limit as number) : 20))
  const r = await host.query(input.sql, inputs, limit)
  if (!r.ok) return err(r.error.message, 'SQL error')
  const types = new Map(r.data.columns.map((c) => [c.name, c.type]))
  const rows = r.data.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v, types.get(k))])))
  return ok({ rowCount: r.data.rowCount, columns: columnsOf(r.data.columns), rows }, `${plural(r.data.rowCount, 'row')}`)
}

// ── the workspace files: editor + apply_workspace ───────────────────────────────────────────────────────

function readColor(v: unknown, kind: VisualizationSpec['kind'], where: string): ColorEncoding | undefined {
  if (v === undefined) return undefined
  need(isObj(v) && str(v.kind), `${where}.color needs a kind`)
  const field = kind === 'vector' ? MAGNITUDE_FIELD : VALUE
  if (v.kind === 'colormap') {
    const cm = v.colormap ?? 'viridis'
    need(str(cm) && cm in COLORMAPS, `${where}.color.colormap must be one of ${Object.keys(COLORMAPS).join(', ')}`)
    need(v.scale === undefined || v.scale === 'linear' || v.scale === 'log', `${where}.color.scale must be linear or log`)
    const d = v.domain
    need(d === undefined || (Array.isArray(d) && d.length === 2 && d.every((x) => typeof x === 'number' && Number.isFinite(x)) && d[0] < d[1]), `${where}.color.domain must be [min, max] with min < max`)
    need(!d || v.scale !== 'log' || (d as number[])[0] > 0, `${where}.color.domain must be positive on a log scale`)
    return {
      kind: 'colormap',
      field,
      colormap: cm as ColormapName,
      ...(v.reverse === true ? { reverse: true } : {}),
      ...(v.scale === 'log' ? { scale: 'log' as const } : {}),
      ...(d ? { domain: [(d as number[])[0], (d as number[])[1]] as [number, number] } : {}),
    }
  }
  if (v.kind === 'categorical') {
    need(kind === 'scalar', `${where}: arrows can't be colored by category`)
    need(v.palette === undefined || PALETTES.includes(v.palette as PaletteName), `${where}.color.palette must be one of ${PALETTES.join(', ')}`)
    return { kind: 'categorical', field, ...(v.palette ? { palette: v.palette as PaletteName } : {}) }
  }
  if (v.kind === 'constant') {
    need(str(v.color) && /^#[0-9a-f]{6}$/i.test(v.color), `${where}.color.color must be a hex color like #3b82f6`)
    return { kind: 'constant', color: v.color }
  }
  throw new Invalid(`${where}.color.kind must be colormap, categorical or constant`)
}

/**
 * The workspace a full description (the assembled workspace files) makes,
 * with every problem listed. Items given as just {id} are kept as they are.
 */
async function buildWorkspace(host: AgentHost, cur: WorkspaceDoc, input: Obj): Promise<{ doc: WorkspaceDoc; errors: string[] }> {
  need(optStr(input.name), '`name` must be text')
  need(Array.isArray(input.datasetIds) && input.datasetIds.every(str), '`datasetIds` must be a list of dataset ids')
  need(Array.isArray(input.transforms), '`transforms` must be a list (send [] for none)')
  need(Array.isArray(input.visualizations), '`visualizations` must be a list (send [] for none)')
  const errors: string[] = []
  let doc: WorkspaceDoc = { ...cur, name: (input.name as string | undefined)?.trim() || cur.name, datasetIds: [], transforms: [], visualizations: [] }
  const records = new Map<string, DatasetRecord>()

  for (const id of input.datasetIds as string[]) {
    const d = await host.dataset(id)
    if (!d) {
      errors.push(`datasetIds: no dataset "${id}"`)
      continue
    }
    records.set(id, d)
    const r = addDataset(doc, id)
    if (r.ok) doc = r.doc
    else errors.push(`datasetIds: ${r.error.message}`)
  }

  for (const [n, raw] of (input.transforms as unknown[]).entries()) {
    const where = `transforms[${n}]`
    try {
      // Just {id}: keep the existing transform as it is.
      if (isObj(raw) && str(raw.id) && Object.keys(raw).length === 1) {
        const t = cur.transforms.find((x) => x.id === raw.id)
        need(t, `${where}: no transform "${raw.id}" to keep (get_workspace lists them)`)
        const r = addTransform(doc, t)
        if (r.ok) doc = r.doc
        else errors.push(`${where} "${t.name}": ${r.error.message}`)
        continue
      }
      need(isObj(raw) && str(raw.name), `${where} needs a name`)
      need(optStr(raw.id), `${where}.id must be text`)
      need(Array.isArray(raw.outputs) && raw.outputs.length, `${where} needs at least one output`)
      const inputs = readInputs(raw.inputs)
      const outputs = (raw.outputs as unknown[]).map((o, m) => {
        need(isObj(o) && str(o.name) && str(o.sql), `${where}.outputs[${m}] needs name and sql`)
        need(optStr(o.key) && optStr(o.outputId), `${where}.outputs[${m}]: key and outputId must be text`)
        const base = newOutput(o.name, o.sql, o.outputId as string | undefined)
        return o.key ? { ...base, key: o.key as string } : base
      })
      for (const o of outputs) {
        if (!o.outputId) continue
        const out = await host.dataset(o.outputId)
        need(out, `${where}: output "${o.name}" writes dataset "${o.outputId}", which doesn't exist (leave outputId out to make a new one)`)
        need(storeOf(out) === 'local', `${where}: output "${o.name}" would write "${out.name}", a cloud dataset — agents change only local datasets`)
      }
      const t: TransformSpec = { id: (raw.id as string | undefined) ?? newId(), name: raw.name, inputs, outputs }
      const r = addTransform(doc, t)
      if (r.ok) doc = r.doc
      else errors.push(`${where} "${raw.name}": ${r.error.message}`)
    } catch (e) {
      if (!(e instanceof Invalid)) throw e
      errors.push(e.message)
    }
  }

  const ctx: OpContext = { columns: (id) => records.get(id)?.columns.map((c) => c.name) }
  for (const [n, raw] of (input.visualizations as unknown[]).entries()) {
    const where = `visualizations[${n}]`
    try {
      // Just {id}: keep the existing visualization as it is.
      if (isObj(raw) && str(raw.id) && Object.keys(raw).length === 1) {
        const v = cur.visualizations.find((x) => x.id === raw.id)
        need(v, `${where}: no visualization "${raw.id}" to keep (get_workspace lists them)`)
        need(records.has(v.datasetId), `${where} "${v.name}": its dataset isn't in datasetIds`)
        const r = addVisualization(doc, v, doc.visualizations.length, ctx)
        if (r.ok) doc = r.doc
        else errors.push(`${where} "${v.name}": ${r.error.message}`)
        continue
      }
      need(isObj(raw) && str(raw.name) && str(raw.datasetId) && str(raw.geometry) && str(raw.column), `${where} needs name, datasetId, geometry and column`)
      need(optStr(raw.id) && optStr(raw.label), `${where}: id and label must be text`)
      need(raw.aggregation === undefined || AGG_NAMES.includes(raw.aggregation as string), `${where}.aggregation must be one of ${AGG_NAMES.join(', ')}`)
      need(raw.visible === undefined || typeof raw.visible === 'boolean', `${where}.visible must be true or false`)
      need(raw.opacity === undefined || (typeof raw.opacity === 'number' && raw.opacity >= 0 && raw.opacity <= 1), `${where}.opacity must be between 0 and 1`)
      need(records.has(raw.datasetId), `${where}: dataset "${raw.datasetId}" isn't in datasetIds`)
      const binding: GeometryBinding = { kind: 'geometry', column: raw.geometry, ...(raw.label ? { label: raw.label as string } : {}) }
      const info = await host.shape(raw.datasetId, binding)
      need(typeof info !== 'string', `${where}: ${info as string}`)
      const column = raw.column
      need(column === ROWS || info.columns.some((c) => c.name === column), `${where}: "${column}" isn't a value column of this dataset under geometry "${raw.geometry}" (columns: ${info.columns.map((c) => c.name).join(', ') || 'none'}; or "${ROWS}")`)
      const type = columnType(info.columns, column)
      const agg = raw.aggregation as Aggregation | undefined
      need(!agg || column === ROWS || aggregationsFor(type).includes(agg), `${where}: ${agg} doesn't apply to a ${type} column (use ${aggregationsFor(type).join(', ')})`)
      const existing = cur.visualizations.find((v) => v.id === raw.id && v.datasetId === raw.datasetId)
      const aggregation = agg ?? (existing && existing.column === column ? existing.aggregation : column === ROWS ? 'count' : defaultAggregation(type, info.maxRowsPerFeature))
      let v: VisualizationSpec = existing ? retarget(info, existing, column, aggregation, binding) : { ...makeVisualization(info, raw.datasetId, binding, column, aggregation), ...(raw.id ? { id: raw.id as string } : {}) }
      v = { ...v, name: raw.name, ...(raw.visible !== undefined ? { visible: raw.visible as boolean } : {}) }
      const color = readColor(raw.color, v.kind, where)
      if (color) v = { ...v, style: { ...v.style, color } } as VisualizationSpec
      if (raw.opacity !== undefined) v = { ...v, style: { ...v.style, opacity: { kind: 'constant', value: raw.opacity as number } } } as VisualizationSpec
      const r = addVisualization(doc, v, doc.visualizations.length, ctx)
      if (r.ok) doc = r.doc
      else errors.push(`${where} "${raw.name}": ${r.error.message}`)
    } catch (e) {
      if (!(e instanceof Invalid)) throw e
      errors.push(e.message)
    }
  }

  return { doc, errors }
}

/** Items whose text the edits left alone, as {id}: kept exactly (style details the text doesn't show included). */
function keepUnchanged(input: Obj, cur: WorkspaceDoc): Obj {
  const same = <T extends { id: string }>(list: unknown, items: T[], show: (x: T) => unknown) => {
    if (!Array.isArray(list)) return list
    const shown = new Map(items.map((x) => [x.id, canonical(show(x))]))
    return list.map((raw) => (isObj(raw) && str(raw.id) && shown.get(raw.id) === canonical(raw) ? { id: raw.id } : raw))
  }
  return { ...input, transforms: same(input.transforms, cur.transforms, agentTransform), visualizations: same(input.visualizations, cur.visualizations, agentVisualization) }
}

/** What changed between two workspaces, an item a line. */
function describeChanges(a: WorkspaceDoc, b: WorkspaceDoc): string[] {
  const out: string[] = []
  if (a.name !== b.name) out.push(`name → "${b.name}"`)
  const addedDs = b.datasetIds.filter((d) => !a.datasetIds.includes(d))
  const removedDs = a.datasetIds.filter((d) => !b.datasetIds.includes(d))
  if (addedDs.length) out.push(`datasets added: ${addedDs.join(', ')}`)
  if (removedDs.length) out.push(`datasets taken out of the workspace: ${removedDs.join(', ')}`)
  const items = <T extends { id: string; name: string }>(kind: string, xs: T[], ys: T[], show: (x: T) => unknown) => {
    const before = new Map(xs.map((x) => [x.id, x]))
    for (const y of ys) {
      const x = before.get(y.id)
      if (!x) out.push(`${kind} added: "${y.name}"`)
      else if (canonical(show(x)) !== canonical(show(y))) out.push(`${kind} changed: "${y.name}"`)
      before.delete(y.id)
    }
    for (const x of before.values()) out.push(`${kind} removed: "${x.name}"`)
  }
  items('transform', a.transforms, b.transforms, agentTransform)
  items('visualization', a.visualizations, b.visualizations, agentVisualization)
  const both = (d: WorkspaceDoc) => d.visualizations.map((v) => v.id).filter((id) => a.visualizations.some((v) => v.id === id) && b.visualizations.some((v) => v.id === id)).join()
  if (both(a) !== both(b)) out.push('visualizations reordered')
  return out
}

async function applyWorkspace(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(input.dryRun === undefined || typeof input.dryRun === 'boolean', '`dryRun` must be true or false')
  const cur = host.doc()
  const s = staging.get(host)
  if (!s || !s.dirty) return err('There are no edits to apply: edit the workspace files first (get_workspace, then the text editor).', 'nothing to apply')
  if (s.base !== workspaceVersion(cur)) {
    return err('The workspace changed since get_workspace (the user edited it), so your edits were made on an old version. Call get_workspace (it discards them), look again, and redo the edits.', 'workspace changed: re-read')
  }
  const refused = (errors: string[]) => err(`Nothing was changed. Fix these in the files and apply again:\n- ${errors.join('\n- ')}`, `refused: ${plural(errors.length, 'problem')}`)
  const assembled = assembleFiles(s.files, cur, newId)
  if (!assembled.ok) return refused(assembled.errors)
  const { input: description, created, unused } = assembled.value
  let built: { doc: WorkspaceDoc; errors: string[] }
  try {
    built = await buildWorkspace(host, cur, keepUnchanged(description, cur))
  } catch (e) {
    if (!(e instanceof Invalid)) throw e
    return refused([e.message])
  }
  if (built.errors.length) return refused(built.errors)
  const { doc } = built
  const changes = describeChanges(cur, doc)
  const notRun = doc.transforms.filter((t) => t.outputs.some((o) => !o.outputId)).map((t) => t.name)
  const added = created.map((c) => ({ kind: c.kind, id: c.id, from: c.file, name: (c.kind === 'transform' ? doc.transforms : doc.visualizations).find((x) => x.id === c.id)?.name }))
  const result = {
    ...(changes.length ? {} : { note: 'The files describe the workspace as it already is: nothing changes.' }),
    [input.dryRun ? 'wouldChange' : 'changed']: changes,
    ...(added.length ? { [input.dryRun ? 'wouldAdd' : 'added']: input.dryRun ? added.map(({ id: _id, ...a }) => a) : added } : {}),
    ...(notRun.length ? { notRunYet: notRun } : {}),
    ...(unused.length ? { unusedFiles: `${unused.map((p) => `/${p}`).join(', ')} — not listed or not used by any output; dropped` } : {}),
  }
  const summary = changes.length ? `${changes[0]}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ''}` : 'no change'
  if (input.dryRun) return ok({ dryRun: true, ...result }, `dry run · ${summary}`)
  host.setDoc(doc)
  // The files start again from the new draft: new items under their ids.
  staged(host, true)
  // New items' files move to their ids; record it so a later edit of the old path is told where it went.
  const moved: Record<string, string> = {}
  const known = renames.get(host) ?? new Map()
  for (const c of created) {
    const pairs: [string, string][] =
      c.kind === 'visualization'
        ? [[vizPath(c.file), vizPath(c.id)]]
        : [[transformPath(c.file), transformPath(c.id)], ...(doc.transforms.find((t) => t.id === c.id)?.outputs ?? []).map((o): [string, string] => [sqlPath(c.file, o.key), sqlPath(c.id, o.key)])]
    for (const [from, to] of pairs) {
      moved[`/${from}`] = `/${to}`
      known.set(from, { path: to, kind: c.kind, id: c.id })
    }
  }
  renames.set(host, known)
  return ok(
    { ...result, ...(added.length ? { renamed: moved } : {}), files: 'Rewritten from the workspace in the standard format: view a file before editing it.' },
    summary,
  )
}

// ── visualization_stats ────────────────────────────────────────────────────

const round = (n: number) => (Number.isInteger(n) ? n : Number(n.toPrecision(4)))
function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo)
}

/** The distribution of a visualization's per-feature values, for choosing its scale and colors. */
export function valueStats(values: VizValues): Obj {
  const features = values.features.length
  const raw = values.features.map((f) => f.value)
  const present = raw.filter((v) => v !== null && v !== undefined && v !== '')
  const base = { features, withValue: present.length, nulls: features - present.length, valueType: values.valueType }
  const nums =
    values.valueType === 'vector'
      ? present.flatMap((v) => {
          const o = v as { u?: number; v?: number }
          return typeof o?.u === 'number' && typeof o.v === 'number' ? [Math.hypot(o.u, o.v)] : []
        })
      : present.flatMap((v) => (typeof v === 'number' && Number.isFinite(v) ? [v] : []))
  if (nums.length && nums.length >= present.length / 2) {
    const s = [...nums].sort((a, b) => a - b)
    const pos = s.filter((x) => x > 0)
    const q = (p: number) => round(quantile(s, p))
    return {
      ...base,
      ...(values.valueType === 'vector' ? { of: 'arrow lengths (magnitudes)' } : {}),
      min: round(s[0]),
      p2: q(0.02),
      p10: q(0.1),
      p25: q(0.25),
      median: q(0.5),
      p75: q(0.75),
      p90: q(0.9),
      p98: q(0.98),
      max: round(s[s.length - 1]),
      mean: round(s.reduce((a, b) => a + b, 0) / s.length),
      atOrBelowZero: s.length - pos.length,
      belowZero: s.filter((x) => x < 0).length,
      ...(pos.length > 1 ? { positiveOrdersOfMagnitude: round(Math.log10(pos[pos.length - 1] / pos[0])) } : {}),
    }
  }
  const counts = new Map<string, number>()
  for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1)
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10)
  return { ...base, distinct: counts.size, mostCommon: Object.fromEntries(top) }
}

async function visualizationStats(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  const v = host.doc().visualizations.find((x) => x.id === input.id)
  need(v, `No visualization "${input.id}" in the workspace (get_workspace lists them)`)
  const values = await host.values(v.datasetId, v.binding, v.column, v.aggregation)
  if (typeof values === 'string') return err(values)
  const stats = valueStats(values)
  return ok({ visualization: v.name, column: v.column, aggregation: v.aggregation, color: agentColor(v.style.color), ...stats }, `${plural(stats.withValue as number, 'feature')} with a value`)
}

// ── run_transform / delete_dataset ─────────────────────────────────────────

async function runTransform(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  const t = host.doc().transforms.find((x) => x.id === input.id)
  need(t, `No transform "${input.id}" in the workspace (get_workspace lists them; never guess an id)`)
  const pending = pendingEdits(host)
  if (pending) return pending
  for (const o of t.outputs) {
    const out = o.outputId ? await host.dataset(o.outputId) : undefined
    if (out && storeOf(out) === 'remote') return err(`Output "${o.name}" writes "${out.name}", a cloud dataset — agents change only local datasets.`, 'refused: cloud output')
  }
  const r = await host.runTransform(t.id)
  if (!r.ok) return err(r.message, 'SQL error')
  return ok({ outputs: r.outputs }, r.outputs.map((o) => `${plural(o.rowCount, 'row')} → ${o.name}`).join(' · '))
}

async function updateDataset(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  need(optStr(input.name) && optStr(input.description), '`name` and `description` must be text')
  need(input.name !== undefined || input.description !== undefined, 'Give a new name, a description, or both')
  need(input.name === undefined || (input.name as string).trim(), 'A dataset needs a name')
  const d = await host.dataset(input.id)
  need(d, `No dataset "${input.id}"`)
  if (storeOf(d) === 'remote') return err(`"${d.name}" is in cloud storage — only the user can change it.`, 'refused: cloud dataset')
  const patch = { ...(input.name !== undefined ? { name: (input.name as string).trim() } : {}), ...(input.description !== undefined ? { description: (input.description as string).trim() } : {}) }
  const r = await host.updateDataset(d.id, patch)
  if (!r.ok) return err(r.message)
  return ok({ id: d.id, ...patch }, patch.name && patch.name !== d.name ? `renamed “${d.name}” → “${patch.name}”` : 'description updated')
}

async function deleteDataset(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  const d = await host.dataset(input.id)
  need(d, `No dataset "${input.id}"`)
  if (storeOf(d) === 'remote') return err(`"${d.name}" is in cloud storage — only the user can delete it.`, 'refused: cloud dataset')
  const pending = pendingEdits(host)
  if (pending) return pending
  const reader = host.doc().transforms.find((t) => t.inputs.some((i) => i.datasetId === d.id))
  if (reader) return err(`Transform "${reader.name}" reads "${d.name}"; change or remove that transform first.`, 'refused: still used')
  const r = await host.deleteDataset(d.id)
  if (!r.ok) return err(r.message)
  return ok({ deleted: d.id }, `deleted ${d.name}`)
}

// ── ask_user ───────────────────────────────────────────────────────────────

async function askUser(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.question) && input.question.trim(), '`question` is required')
  need(optStr(input.details), '`details` must be text')
  const a = await host.ask(input.question.trim(), (input.details as string | undefined)?.trim() || undefined)
  return ok(a, `${a.answer === 'approve' ? 'approved' : 'rejected'}${a.notes ? ` · “${a.notes.length > 60 ? `${a.notes.slice(0, 60)}…` : a.notes}”` : ''}`)
}

// ── dispatch ───────────────────────────────────────────────────────────────

/** Runs a tool call: validated, gated, never throwing. */
export async function runTool(host: AgentHost, name: string, input: unknown): Promise<ToolOutcome> {
  try {
    need(isObj(input), 'The tool input must be a JSON object')
    switch (name) {
      case 'list_datasets':
        return await listDatasets(host)
      case 'get_workspace':
        return await getWorkspace(host)
      case 'ask_user':
        return await askUser(host, input)
      case 'query_sql':
        return await querySql(host, input)
      case EDITOR_TOOL:
        return await editor(host, input)
      case 'apply_workspace':
        return await applyWorkspace(host, input)
      case 'visualization_stats':
        return await visualizationStats(host, input)
      case 'run_transform':
        return await runTransform(host, input)
      case 'update_dataset':
        return await updateDataset(host, input)
      case 'delete_dataset':
        return await deleteDataset(host, input)
      default:
        return err(`Unknown tool "${name}"`)
    }
  } catch (e) {
    return e instanceof Invalid ? err(e.message, 'invalid input') : err(`The tool failed: ${(e as Error).message ?? String(e)}`, 'failed')
  }
}

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

const colorSchema = {
  type: 'object',
  description:
    'How features are colored by their value. colormap: a color ramp for numbers; categorical: one color per value (text); constant: one color. Leave out to keep the current color (or the default for the value type).',
  properties: {
    kind: { type: 'string', enum: ['colormap', 'categorical', 'constant'] },
    colormap: { type: 'string', enum: Object.keys(COLORMAPS) },
    reverse: { type: 'boolean' },
    scale: { type: 'string', enum: ['linear', 'log'] },
    palette: { type: 'string', enum: PALETTES },
    color: { type: 'string', description: 'For constant: a hex color like #3b82f6' },
    domain: {
      type: 'array',
      items: { type: 'number' },
      description:
        'For colormap: a fixed [min, max] the ramp spans; values beyond take the end colors. Use it to clip outliers (e.g. the 2nd–98th percentile) or to center a diverging map on its midpoint (e.g. [-m, m] around 0). Leave out to span the data.',
    },
  },
  required: ['kind'],
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'get_workspace',
    description:
      "The user's workspace — where to start. Its datasets (id, name, description, store local / remote, origin, row count; no columns: query the ones that look relevant), its transforms (id, inputs, outputs with SQL, state: ready / not-run / stale) and visualizations (id, dataset, geometry column, value column, aggregation, color), plus a version stamp that update_workspace needs. Call it first, and again after the user changes things.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_datasets',
    description:
      "Every dataset the user can use, including those outside the workspace, local and remote: id, name, description, store, origin, row count, inWorkspace. Use it only when the workspace doesn't hold what the request needs, and after asking the user (ask_user) whether to look beyond the workspace.",
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
      'Run one read-only SELECT (DuckDB) over datasets and get the first rows plus the total row count. Nothing is stored. Each input dataset is a table named by its alias. Geometry cells come back as "<region>" etc. Use it to profile (FROM (SUMMARIZE t)), check values and join coverage, and test transform SQL before writing it. CTEs (WITH …) chain steps. Works on any dataset, local or remote, in the workspace or not.',
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
    name: 'update_workspace',
    description:
      "Replace the workspace's contents (the user's unsaved draft: they Save or Discard it). Send the complete lists — anything left out is removed from the workspace (datasets stay stored). Keep the ids of items you keep; leave id out for new ones. Transforms: SQL that writes datasets, one SELECT per output; an output without outputId writes a new dataset on its first run, then keep the outputId get_workspace shows. A new or changed transform does nothing until run_transform. Visualizations: draw one value column of a dataset on its features (a geometry column); rows on the same feature are combined by the aggregation. The list order is draw order: first draws on top. Refused if the workspace changed since `version`, or if a transform would write a remote dataset; nothing is applied when anything is invalid.",
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'The version from the latest get_workspace / update_workspace.' },
        name: { type: 'string' },
        datasetIds: { type: 'array', items: { type: 'string' } },
        transforms: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              inputs: {
                type: 'array',
                items: { type: 'object', properties: { datasetId: { type: 'string' }, alias: { type: 'string' } }, required: ['datasetId', 'alias'] },
              },
              outputs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { key: { type: 'string' }, name: { type: 'string' }, sql: { type: 'string' }, outputId: { type: 'string' } },
                  required: ['name', 'sql'],
                },
              },
            },
            required: ['name', 'inputs', 'outputs'],
          },
        },
        visualizations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              datasetId: { type: 'string' },
              geometry: { type: 'string', description: 'The geometry column (point / polyline / region) that places each row.' },
              label: { type: 'string', description: 'Optional column naming each feature (shown on hover and in Find).' },
              column: { type: 'string', description: `The value column, or "${ROWS}" for the number of rows per feature.` },
              aggregation: { type: 'string', enum: AGG_NAMES, description: 'How rows on one feature combine. Default: pass-through when each feature has one row, else a summary.' },
              visible: { type: 'boolean' },
              color: colorSchema,
              opacity: { type: 'number', description: '0–1' },
            },
            required: ['name', 'datasetId', 'geometry', 'column'],
          },
        },
      },
      required: ['version', 'datasetIds', 'transforms', 'visualizations'],
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
      'Run one transform of the workspace (its current SQL): every output is written, or none if any SQL fails. New output datasets join the workspace (without visualizations). Returns row counts and dataset ids. Refused if an output would write a remote dataset.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'update_dataset',
    description:
      "Rename a local dataset and/or set its description (its rows don't change). Refused for remote datasets. Give datasets you create a clear name and a one-line description (what each row is, the source, the period), so they're easy to find later.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'delete_dataset',
    description:
      'Delete a local dataset and its rows for good (and its visualizations). Refused for remote datasets, and while a workspace transform reads it. Use it to clean up datasets you made that are no longer needed.',
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

function compactColor(c: ColorEncoding): Obj {
  if (c.kind === 'colormap') return { kind: c.kind, colormap: c.colormap, ...(c.reverse ? { reverse: true } : {}), ...(c.scale === 'log' ? { scale: 'log' } : {}), ...(c.domain ? { domain: c.domain } : {}) }
  if (c.kind === 'categorical') return { kind: c.kind, ...(c.palette ? { palette: c.palette } : {}) }
  return { kind: c.kind, color: c.color }
}

// ── list_datasets / get_workspace ──────────────────────────────────────────

async function listDatasets(host: AgentHost): Promise<ToolOutcome> {
  const inWorkspace = new Set(host.doc().datasetIds)
  const all = await host.listDatasets()
  const data = all.map((d) => ({
    id: d.id,
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    store: storeOf(d),
    origin: d.origin,
    rows: d.rowCount,
    inWorkspace: inWorkspace.has(d.id),
  }))
  return ok(data, `${plural(data.length, 'dataset')} (${data.filter((d) => d.store === 'local').length} local)`)
}

async function getWorkspace(host: AgentHost): Promise<ToolOutcome> {
  const doc = host.doc()
  // Transform states need their outputs' records too, which may sit outside the workspace.
  const byId = new Map((await host.listDatasets()).map((d) => [d.id, d]))
  const data = {
    version: workspaceVersion(doc),
    name: doc.name,
    datasets: doc.datasetIds.map((id) => {
      const d = byId.get(id)
      if (!d) return { id, name: '(missing)' }
      return { id, name: d.name, ...(d.description ? { description: d.description } : {}), store: storeOf(d), origin: d.origin, rows: d.rowCount }
    }),
    transforms: doc.transforms.map((t) => ({ id: t.id, name: t.name, state: transformState(t, (id) => byId.get(id)), inputs: t.inputs, outputs: t.outputs })),
    visualizations: doc.visualizations.map((v) => ({
      id: v.id,
      name: v.name,
      datasetId: v.datasetId,
      geometry: v.binding.column,
      ...(v.binding.label ? { label: v.binding.label } : {}),
      column: v.column,
      aggregation: v.aggregation,
      visible: v.visible,
      color: compactColor(v.style.color),
      ...(v.kind === 'scalar' && v.style.opacity.kind === 'constant' ? { opacity: v.style.opacity.value } : {}),
    })),
  }
  return ok(data, `${plural(data.datasets.length, 'dataset')} · ${plural(data.transforms.length, 'transform')} · ${plural(data.visualizations.length, 'visualization')}`)
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

// ── update_workspace ───────────────────────────────────────────────────────

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

async function updateWorkspace(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  const cur = host.doc()
  need(str(input.version), '`version` is required (from get_workspace)')
  if (input.version !== workspaceVersion(cur)) return err('The workspace changed since you read it (the user may have edited it). Call get_workspace and try again.', 'workspace changed: re-read')
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
        need(storeOf(out) === 'local', `${where}: output "${o.name}" would write "${out.name}", a remote dataset — agents change only local datasets`)
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

  if (errors.length) return err(`Nothing was changed. Fix these and send the whole workspace again:\n- ${errors.join('\n- ')}`, `refused: ${plural(errors.length, 'problem')}`)
  host.setDoc(doc)
  const notRun = doc.transforms.filter((t) => t.outputs.some((o) => !o.outputId)).map((t) => t.name)
  return ok(
    { version: workspaceVersion(doc), datasets: doc.datasetIds.length, transforms: doc.transforms.length, visualizations: doc.visualizations.length, ...(notRun.length ? { notRunYet: notRun } : {}) },
    `${plural(doc.datasetIds.length, 'dataset')} · ${plural(doc.transforms.length, 'transform')} · ${plural(doc.visualizations.length, 'visualization')}`,
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
  return ok({ visualization: v.name, column: v.column, aggregation: v.aggregation, color: compactColor(v.style.color), ...stats }, `${plural(stats.withValue as number, 'feature')} with a value`)
}

// ── run_transform / delete_dataset ─────────────────────────────────────────

async function runTransform(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  const t = host.doc().transforms.find((x) => x.id === input.id)
  need(t, `No transform "${input.id}" in the workspace (get_workspace lists them)`)
  for (const o of t.outputs) {
    const out = o.outputId ? await host.dataset(o.outputId) : undefined
    if (out && storeOf(out) === 'remote') return err(`Output "${o.name}" writes "${out.name}", a remote dataset — agents change only local datasets.`, 'refused: remote output')
  }
  const r = await host.runTransform(t.id)
  if (!r.ok) return err(r.message, 'SQL error')
  return ok({ outputs: r.outputs, version: workspaceVersion(host.doc()) }, r.outputs.map((o) => `${plural(o.rowCount, 'row')} → ${o.name}`).join(' · '))
}

async function updateDataset(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  need(optStr(input.name) && optStr(input.description), '`name` and `description` must be text')
  need(input.name !== undefined || input.description !== undefined, 'Give a new name, a description, or both')
  need(input.name === undefined || (input.name as string).trim(), 'A dataset needs a name')
  const d = await host.dataset(input.id)
  need(d, `No dataset "${input.id}"`)
  if (storeOf(d) === 'remote') return err(`"${d.name}" is in remote storage — only the user can change it.`, 'refused: remote dataset')
  const patch = { ...(input.name !== undefined ? { name: (input.name as string).trim() } : {}), ...(input.description !== undefined ? { description: (input.description as string).trim() } : {}) }
  const r = await host.updateDataset(d.id, patch)
  if (!r.ok) return err(r.message)
  return ok({ id: d.id, ...patch }, patch.name && patch.name !== d.name ? `renamed “${d.name}” → “${patch.name}”` : 'description updated')
}

async function deleteDataset(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  const d = await host.dataset(input.id)
  need(d, `No dataset "${input.id}"`)
  if (storeOf(d) === 'remote') return err(`"${d.name}" is in remote storage — only the user can delete it.`, 'refused: remote dataset')
  const reader = host.doc().transforms.find((t) => t.inputs.some((i) => i.datasetId === d.id))
  if (reader) return err(`Transform "${reader.name}" reads "${d.name}"; change or remove that transform first.`, 'refused: still used')
  const r = await host.deleteDataset(d.id)
  if (!r.ok) return err(r.message)
  return ok({ deleted: d.id, version: workspaceVersion(host.doc()) }, `deleted ${d.name}`)
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
      case 'update_workspace':
        return await updateWorkspace(host, input)
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

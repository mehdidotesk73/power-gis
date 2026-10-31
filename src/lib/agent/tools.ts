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
import { MAGNITUDE_FIELD, PATTERNS, type ColorEncoding, type OpacityEncoding, type PatternEncoding, type PatternKind, type ScalarStyle, type VectorStyle } from '../style'
import { addDataset, addTransform, addVisualization, newOutput, type OpContext, type TransformSpec, type WorkspaceDoc } from '../workspace/workspace'
import { outputCheck } from './checks'
import { transformState } from '../workspace/dag'
import { datasetFact, snapshot } from '../workspace/file'
import type { ToolOutcome } from './loop'
import { agentColor, agentTransform, agentVisualization, assembleFiles, canonical, EDITOR_TOOL, OVERVIEW, overviewText, runEditor, sqlPath, transformPath, vizPath, workspaceFiles, type DatasetFacts, type Files } from './workspaceFiles'
import type { ToolSpec } from './provider'
import { answerSummary, LIMITS, readForm, type Form, type FormAnswer } from './form'

/** What the tools act through: the page's workspace copy and the server. */
export interface AgentHost {
  doc(): WorkspaceDoc
  setDoc(doc: WorkspaceDoc): void
  dataset(id: string): Promise<DatasetRecord | undefined>
  /** A workspace dataset's record as the page shows it (drafted name / description on top), if it's here. */
  record(id: string): DatasetRecord | undefined
  /** Every dataset the user can use, local and remote (the app's dataset finder). */
  listDatasets(): Promise<DatasetRecord[]>
  query(sql: string, inputs: TransformInputRef[], limit: number): Promise<ApiResult<{ columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number }>>
  /** How a dataset looks under a geometry binding, or an error message. */
  shape(datasetId: string, binding: GeometryBinding): Promise<BindingInfo | string>
  /** The values a visualization draws, one per feature (what the map colors), or an error message. */
  values(datasetId: string, binding: GeometryBinding, column: string, aggregation: Aggregation): Promise<VizValues | string>
  runTransform(id: string): Promise<{ ok: true; outputs: { datasetId: string; name: string; rowCount: number; created: boolean }[] } | { ok: false; message: string }>
  deleteDataset(id: string): Promise<{ ok: true } | { ok: false; message: string }>
  /** Drafts a dataset's new name / description (written to it when the user saves). */
  updateDataset(id: string, patch: { name?: string; description?: string }): { ok: true } | { ok: false; message: string }
  /** Shows the user a question card (details, fields, buttons); resolves with their answer. */
  ask(form: Form): Promise<FormAnswer>
  /** Adds a file (a scraper's CSV or GeoJSON) as a new dataset in the workspace, with a description. */
  importCsv?(file: File, description: string): Promise<{ ok: true; id: string } | { ok: false; message: string }>
  /** Sends the scout or the scraper with a brief and a spending cap, and follows it to the end (the chat shows its progress); a message when it can't. */
  web?(role: WebRole, brief: string, capDollars: number): Promise<WebRun | string>
  /** Imports one of a web run's output files (a CSV or GeoJSON) as a new dataset; its id, or a message. */
  importWebFile?(fileId: string, name: string, description: string): Promise<{ ok: true; id: string } | { ok: false; message: string }>
  /** The tables that ship with the app (state and county boundaries…), whether or not they're stored on this device yet. */
  builtins?(): { table: string; label: string; description: string }[]
  /** Adds a built-in table to the workspace (stored on this device first if it isn't yet); its dataset id. */
  addBuiltin?(table: string): Promise<{ ok: true; id: string } | { ok: false; message: string }>
  /** Runs the storyteller on some visualizations (a new story, or `storyId` rewritten); what it wrote, or why it couldn't. */
  tellStory?(req: { visualizationIds: string[]; wishes: string; storyId?: string }): Promise<{ storyId: string; name: string; scenes: string[] } | string>
}

export type WebRole = 'scout' | 'scraper'
export interface WebRun {
  sessionId: string
  report: string
  files: { id: string; name: string; bytes: number }[]
  /** Files the run said it saved that never came back. */
  missing?: string[]
  cost?: number
  elapsedSeconds: number
  /** Why it stopped: end_turn when it finished; stopped, budget_reached, terminated… otherwise. */
  stop: string
}

/** The spending caps the approval card offers, in dollars. */
export const WEB_CAPS = [0.5, 1, 2, 5]

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
      "Every dataset the user can use, including those outside the workspace, local and cloud: id, name, description, store, origin, row count, inWorkspace; and the built-in geographic tables that ship with the app (US state and county boundaries), under builtins: add one with add_builtin, no web needed. Use it only when the workspace doesn't hold what the request needs, and after asking the user (ask_user) whether to look beyond the workspace.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ask_user',
    description: [
      'Ask the user something that needs a well-defined answer, and wait for it. Shows a card in the chat: your question, optional details, any fields, and buttons. Returns {button, values} (values by field id; a choice gives a list of the chosen options, with the user\'s own answer last).',
      'Without fields, the buttons default to Approve / Reject: use that to confirm a plan, with the plan in details. Fields: "text" (one line, or multiline; "value" fills it in for the user to review and edit — a plan, a name, a brief) and "choice" (options; "multiple" for any number of them; "other" to let the user add their own answer). Buttons: the first is the main answer (only it needs the required fields); add others for the alternatives, e.g. ["Use this source", "Skip this data", "Find another source"].',
      'Use it to confirm a plan before building, to ask before looking outside the workspace or on the web, and whenever the answer is a pick from options or an edit of something you drafted. Keep labels to a few words. For an open question, ask in plain text and end your turn instead.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One short question.' },
        details: { type: 'string', description: 'Optional: what you found and what you propose, in a few short lines.' },
        fields: {
          type: 'array',
          description: `Optional, at most ${LIMITS.fields}.`,
          // Every property required (empty when unused): under strict tool use, optional text and lists
          // inside the items came through missing (a framing box and its options arrived empty).
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Key of this field in the answer.' },
              kind: { type: 'string', enum: ['text', 'choice'] },
              label: { type: 'string', description: 'A few words.' },
              value: { type: 'string', description: 'text: filled in for the user to review and edit — a draft you mention must be here in full (the box shows only this); "" for a blank box or a choice.' },
              placeholder: { type: 'string', description: 'text: a hint shown while empty; "" for none.' },
              multiline: { type: 'boolean', description: 'text: several lines.' },
              options: { type: 'array', items: { type: 'string' }, description: `choice: every option, at most ${LIMITS.options}; [] for text.` },
              multiple: { type: 'boolean', description: 'choice: any number of options rather than one.' },
              other: { type: 'boolean', description: 'choice: the user may add their own answer.' },
              selected: { type: 'array', items: { type: 'string' }, description: 'choice: options chosen to start with; [] for none.' },
              required: { type: 'boolean' },
            },
            required: ['id', 'kind', 'label', 'value', 'placeholder', 'multiline', 'options', 'multiple', 'other', 'selected', 'required'],
          },
        },
        buttons: { type: 'array', items: { type: 'string' }, description: `The answers, main one first; at most ${LIMITS.buttons}. Default: Approve, Reject without fields; Submit with them.` },
      },
      required: ['question'],
    },
  },
  {
    name: 'add_builtin',
    description:
      'Add one of the built-in geographic tables (list_datasets → builtins: US state or county boundaries) to the workspace: instant and free. Returns its dataset id.',
    inputSchema: { type: 'object', properties: { table: { type: 'string', description: 'The built-in table name, e.g. us_states.' } }, required: ['table'] },
  },
  {
    name: 'send_scout',
    description:
      "Send the scout to find out what data exists on the web for a question: it searches, follows links to where data actually lives, peeks at files' layouts, reads terms of use, and reports back (it extracts nothing). It runs in a container on Anthropic's servers, takes a minute or a few and costs cents. The user approves (and may edit) the brief and the spending cap first. Returns its report. Use it when the source isn't known; then propose a scraper brief from the report.",
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'What to look for: the question, what the data must cover (what, where, when, level of detail), candidate sources if any, and what to report.' },
        cap_dollars: { type: 'number', description: `Spending cap to propose: one of ${WEB_CAPS.join(', ')} (default 1).` },
      },
      required: ['brief'],
    },
  },
  {
    name: 'send_scraper',
    description:
      "Send the scraper to fetch data from the web into CSV tables: it writes and runs Python in a container on Anthropic's servers (downloads, Excel, PDF tables, pages built by JavaScript), checks its result, and returns CSVs that are added to the workspace as new datasets, plus its script. Takes a few minutes and costs cents. The user approves (and may edit) the brief and the spending cap first. Returns its summary and each file's dataset id.",
    inputSchema: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: "Precise: which sources (URLs), what to extract, and for each output CSV its file name and columns (with units and key formats, e.g. fips as 5-digit text), one row per what. Everything it needs: it can't ask you.",
        },
        cap_dollars: { type: 'number', description: `Spending cap to propose: one of ${WEB_CAPS.join(', ')} (default 2).` },
      },
      required: ['brief'],
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
      `Visualizations hold every setting: {"kind" ("scalar"; "vector" for a vector column: arrows), "name", "datasetId", "visible", "binding": {"kind": "geometry", "column" (a point / polyline / region column), "label"? (a column naming each feature)}, "column" (or "${ROWS}"), "aggregation" (${AGG_NAMES.join(', ')}), "style"}. For a new one, name, datasetId, binding and column are enough: the rest gets defaults (kind follows the column). In "style", change only the parts you mean to; leave the "field" values as they are (they always mean the drawn value).`,
      `Scalar style: {"color", "opacity", "pattern", "outline"?, "size"?}. color: {"kind": "colormap", "colormap", "reverse"?, "scale"? ("linear" / "log"), "domain"? ([min, max]), "nullColor"?} | {"kind": "categorical", "palette"?, "colors"? ({value: "#rrggbb"})} | {"kind": "constant", "color": "#rrggbb"}. opacity: {"kind": "constant", "value" (0–1)} | {"kind": "field", "range" ([low, high] opacity), "domain"?}. pattern (regions only): {"kind": "none"} | {"kind": "constant", "pattern" (${PATTERNS.join(', ')}), "color"?, "opacity"?} | {"kind": "field", "patterns" ({value: pattern})}. outline: {"color", "width" (px), "opacity"?}; size: point radius / line width in px. Vector style: {"components" (follows the column), "color" (by arrow length; not categorical), "opacity", "size": {"min", "max" (1 = 24px), "domain"?}}. Items you didn't edit stay exactly as they are.`,
      'dryRun: check and describe the change without applying it. Refused if the user changed the workspace since get_workspace.',
    ].join('\n\n'),
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: 'Check and describe the change without applying it.' },
        userAsked: {
          type: 'array',
          items: { type: 'string' },
          description: "Ids of items you didn't make in this chat that the user asked, by name, to be removed. Anything else you didn't make can't be removed.",
        },
      },
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
      'Run one transform of the workspace (its current SQL): every output is written, or none if any SQL fails. New output datasets join the workspace (without visualizations). Returns, per output, its dataset id and a check: its rows and each input\'s, the columns unique on every row (keys), each column\'s nulls, distinct values and range, and flags worth a look (more rows than any input, no unique column, an empty column). It changes this device\'s copies only: an output linked to the cloud turns ↑ (changed here) until the user syncs it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'delete_dataset',
    description:
      'Delete a dataset\'s copy on this device and its rows for good (and its visualizations); a linked dataset\'s cloud copy stays. Refused while a workspace transform reads it. Use it to clean up datasets you made in this chat that are no longer needed; one you didn\'t make only when the user asked for it by name (userAsked).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userAsked: { type: 'boolean', description: 'The user asked, by name, for this dataset to be deleted.' } }, required: ['id'] },
  },
  {
    name: 'tell_story',
    description:
      'Have the storyteller write a story about some visualizations: scenes that walk from their starting data, through each transform, to the maps, each a short narrative with a figure or two (rows, a chart, a map). It reads the datasets\' descriptions and the SQL, so describe datasets well first. Give the visualizations\' ids, the user\'s wishes for it ("" if none), and storyId to rewrite an existing story ("" for a new one). It returns the story\'s id, title and scenes; the story is in the workspace draft (Stories in the list view). It changes nothing else.',
    inputSchema: {
      type: 'object',
      properties: {
        visualizationIds: { type: 'array', items: { type: 'string' } },
        wishes: { type: 'string', description: 'What the user asked of the story (focus, length, audience, changes to make), or "".' },
        storyId: { type: 'string', description: 'The story to rewrite, or "" for a new one.' },
      },
      required: ['visualizationIds', 'wishes', 'storyId'],
    },
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

export class Invalid extends Error {}
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
  const builtins = host.builtins?.() ?? []
  const shown = builtins.length ? { datasets: data, builtins: builtins.map((b) => ({ table: b.table, name: b.label, description: b.description })) } : data
  return ok(shown, `${plural(data.length, 'dataset')} (${data.filter((d) => d.store === 'local').length} local)${builtins.length ? ` · ${plural(builtins.length, 'built-in table')}` : ''}`)
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
/** What the agent made in this chat (transforms, visualizations, datasets, datasets it brought in): only these it may remove unasked. */
const madeHere = new WeakMap<AgentHost, Set<string>>()
const made = (host: AgentHost) => madeHere.get(host) ?? (madeHere.set(host, new Set()), madeHere.get(host)!)
/** Datasets this chat made, still in the workspace, with no description (or a bare line): the next person has nothing else to go on. */
const BRIEF = 80
function undescribed(host: AgentHost): Obj {
  const mine = made(host)
  const list = host
    .doc()
    .datasetIds.filter((id) => mine.has(id))
    .map((id) => ({ id, name: host.record(id)?.name ?? id, description: host.record(id)?.description?.trim() ?? '' }))
    .filter((d) => d.description.length < BRIEF || d.description.includes(PLACEHOLDER))
  if (!list.length) return {}
  return {
    describe: `${list.map((d) => `"${d.name}" (${d.id})${!d.description ? '' : d.description.includes(PLACEHOLDER) ? ': only the import note' : ': only a line'}`).join(', ')} — datasets you made that still need a description: describe them in /datasets.json (see Describing datasets), then apply_workspace.`,
  }
}

/** A new chat starts afresh: no staged files, nothing made yet. */
export function forgetChat(host: AgentHost) {
  staging.delete(host)
  renames.delete(host)
  madeHere.delete(host)
}

const renames = new WeakMap<AgentHost, Map<string, { path: string; kind: string; id: string }>>()

/** What datasets.json says about the workspace's datasets. */
const facts = (host: AgentHost) => (id: string): DatasetFacts | undefined => {
  const d = host.record(id)
  if (!d) return undefined
  const { id: _id, ...fact } = datasetFact(id, d, host.doc().transforms)
  return fact
}

/** The host's files, rebuilt from the draft when nothing is pending and the draft changed. */
function staged(host: AgentHost, fresh = false): Staging {
  const version = workspaceVersion(host.doc())
  const s = staging.get(host)
  if (s && !fresh && (s.dirty || s.base === version)) return s
  const next = { files: workspaceFiles(host.doc(), facts(host)), base: version, dirty: false }
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
      ...(v.nullColor !== undefined ? { nullColor: hex(v.nullColor, `${where}.color.nullColor`) } : {}),
    }
  }
  if (v.kind === 'categorical') {
    need(kind === 'scalar', `${where}: arrows can't be colored by category`)
    need(v.palette === undefined || PALETTES.includes(v.palette as PaletteName), `${where}.color.palette must be one of ${PALETTES.join(', ')}`)
    need(v.colors === undefined || isObj(v.colors), `${where}.color.colors must map values to hex colors`)
    const colors = v.colors ? Object.fromEntries(Object.entries(v.colors as Obj).map(([k, c]) => [k, hex(c, `${where}.color.colors["${k}"]`)])) : undefined
    return { kind: 'categorical', field, ...(v.palette ? { palette: v.palette as PaletteName } : {}), ...(colors && Object.keys(colors).length ? { colors } : {}) }
  }
  if (v.kind === 'constant') {
    need(str(v.color) && /^#[0-9a-f]{6}$/i.test(v.color), `${where}.color.color must be a hex color like #3b82f6`)
    return { kind: 'constant', color: v.color }
  }
  throw new Invalid(`${where}.color.kind must be colormap, categorical or constant`)
}

const hex = (c: unknown, where: string): string => {
  need(str(c) && /^#[0-9a-f]{6}$/i.test(c), `${where} must be a hex color like #3b82f6`)
  return c
}
const unit = (x: unknown, where: string): number => {
  need(typeof x === 'number' && x >= 0 && x <= 1, `${where} must be between 0 and 1`)
  return x
}
const range = (d: unknown, where: string): [number, number] => {
  need(Array.isArray(d) && d.length === 2 && d.every((x) => typeof x === 'number' && Number.isFinite(x)) && d[0] < d[1], `${where} must be [min, max] with min < max`)
  return [d[0], d[1]]
}
function allowed(o: Obj, keys: string[], where: string) {
  for (const k of Object.keys(o)) need(keys.includes(k), `${where}: unknown field "${k}" (fields: ${keys.join(', ')})`)
}

function readOpacity(v: unknown, field: string, where: string): OpacityEncoding {
  need(isObj(v), `${where}.opacity must be {"kind": "constant", "value"} or {"kind": "field", "range", "domain"?}`)
  if (v.kind === 'constant') return { kind: 'constant', value: unit(v.value, `${where}.opacity.value`) }
  need(v.kind === 'field', `${where}.opacity.kind must be constant or field`)
  const r = range(v.range, `${where}.opacity.range`)
  unit(r[0], `${where}.opacity.range`), unit(r[1], `${where}.opacity.range`)
  return { kind: 'field', field, range: r, ...(v.domain !== undefined ? { domain: range(v.domain, `${where}.opacity.domain`) } : {}) }
}

function readPattern(v: unknown, where: string): PatternEncoding {
  need(isObj(v), `${where}.pattern must be {"kind": "none"}, {"kind": "constant", "pattern"} or {"kind": "field", "patterns"}`)
  const kind = (p: unknown, w: string): PatternKind => {
    need(PATTERNS.includes(p as PatternKind), `${w} must be one of ${PATTERNS.join(', ')}`)
    return p as PatternKind
  }
  const extras = { ...(v.color !== undefined ? { color: hex(v.color, `${where}.pattern.color`) } : {}), ...(v.opacity !== undefined ? { opacity: unit(v.opacity, `${where}.pattern.opacity`) } : {}) }
  if (v.kind === 'none') return { kind: 'none' }
  if (v.kind === 'constant') return { kind: 'constant', pattern: kind(v.pattern, `${where}.pattern.pattern`), ...extras }
  need(v.kind === 'field' && isObj(v.patterns), `${where}.pattern.kind must be none, constant or field (with "patterns": value → pattern)`)
  return { kind: 'field', field: VALUE, patterns: Object.fromEntries(Object.entries(v.patterns as Obj).map(([k, p]) => [k, kind(p, `${where}.pattern.patterns["${k}"]`)])), ...extras }
}

/**
 * A visualization's style from its file, over `base` (the current or default style): each part
 * given is checked and replaces base's. The fields encodings read are always the drawn value
 * (or the arrows' length), whatever the file says; arrows' components follow the column.
 */
function readStyle(raw: unknown, v: VisualizationSpec, where: string): VisualizationSpec['style'] {
  need(isObj(raw), `${where}.style must be an object`)
  const w = `${where}.style`
  if (v.kind === 'vector') {
    allowed(raw, ['components', 'color', 'opacity', 'size'], w)
    const base: VectorStyle = v.style
    let size = base.size
    if (raw.size !== undefined) {
      const s = raw.size
      need(isObj(s) && typeof s.min === 'number' && typeof s.max === 'number' && s.min > 0 && s.max >= s.min, `${w}.size must be {"min", "max"} with 0 < min ≤ max (1 = 24px)`)
      size = { min: s.min, max: s.max, ...(s.domain !== undefined ? { domain: range(s.domain, `${w}.size.domain`) } : {}) }
    }
    return {
      components: base.components,
      color: readColor(raw.color, 'vector', w) ?? base.color,
      opacity: raw.opacity !== undefined ? readOpacity(raw.opacity, MAGNITUDE_FIELD, w) : base.opacity,
      size,
    }
  }
  allowed(raw, ['color', 'opacity', 'pattern', 'outline', 'size'], w)
  const base: ScalarStyle = v.style
  let outline = base.outline
  if (raw.outline !== undefined) {
    const o = raw.outline
    need(isObj(o) && typeof o.width === 'number' && o.width >= 0 && o.width <= 20, `${w}.outline must be {"color", "width" (0–20), "opacity"?}`)
    outline = { color: hex(o.color, `${w}.outline.color`), width: o.width, ...(o.opacity !== undefined ? { opacity: unit(o.opacity, `${w}.outline.opacity`) } : {}) }
  }
  need(raw.size === undefined || (typeof raw.size === 'number' && raw.size > 0 && raw.size <= 50), `${w}.size must be a number of pixels (point radius / line width), up to 50`)
  return {
    color: readColor(raw.color, 'scalar', w) ?? base.color,
    opacity: raw.opacity !== undefined ? readOpacity(raw.opacity, VALUE, w) : base.opacity,
    pattern: raw.pattern !== undefined ? readPattern(raw.pattern, w) : base.pattern,
    ...(outline ? { outline } : {}),
    ...(raw.size !== undefined ? { size: raw.size as number } : base.size !== undefined ? { size: base.size } : {}),
  }
}

/**
 * The workspace a full description (the assembled workspace files) makes,
 * with every problem listed. Items given as just {id} are kept as they are.
 */
/**
 * A visualization from its file form ({name, datasetId, binding, column, aggregation?, kind?, visible?, style?}),
 * checked against the dataset; `existing` (the same id) keeps its style where the kind of value is unchanged.
 * Throws Invalid with what's wrong.
 */
export async function readVisualization(host: Pick<AgentHost, 'shape'>, raw: Obj, where: string, existing?: VisualizationSpec): Promise<VisualizationSpec> {
  need(isObj(raw) && str(raw.name) && str(raw.datasetId) && str(raw.column), `${where} needs name, datasetId, binding and column`)
  const b = raw.binding
  need(isObj(b) && str(b.column) && (b.kind === undefined || b.kind === 'geometry') && optStr(b.label), `${where}.binding must be {"kind": "geometry", "column": <a geometry column>, "label"?: <a column naming each feature>}`)
  need(optStr(raw.id), `${where}: id must be text`)
  need(raw.kind === undefined || raw.kind === 'scalar' || raw.kind === 'vector', `${where}.kind must be scalar or vector`)
  need(raw.aggregation === undefined || AGG_NAMES.includes(raw.aggregation as string), `${where}.aggregation must be one of ${AGG_NAMES.join(', ')}`)
  need(raw.visible === undefined || typeof raw.visible === 'boolean', `${where}.visible must be true or false`)
  const binding: GeometryBinding = { kind: 'geometry', column: b.column, ...(b.label ? { label: b.label as string } : {}) }
  const info = await host.shape(raw.datasetId, binding)
  need(typeof info !== 'string', `${where}: ${info as string}`)
  const column = raw.column
  need(column === ROWS || info.columns.some((c) => c.name === column), `${where}: "${column}" isn't a value column of this dataset under geometry "${binding.column}" (columns: ${info.columns.map((c) => c.name).join(', ') || 'none'}; or "${ROWS}")`)
  const type = columnType(info.columns, column)
  const agg = raw.aggregation as Aggregation | undefined
  need(!agg || column === ROWS || aggregationsFor(type).includes(agg), `${where}: ${agg} doesn't apply to a ${type} column (use ${aggregationsFor(type).join(', ')})`)
  const aggregation = agg ?? (existing && existing.column === column ? existing.aggregation : column === ROWS ? 'count' : defaultAggregation(type, info.maxRowsPerFeature))
  let v: VisualizationSpec = existing ? retarget(info, existing, column, aggregation, binding) : { ...makeVisualization(info, raw.datasetId, binding, column, aggregation), ...(raw.id ? { id: raw.id as string } : {}) }
  v = { ...v, name: raw.name, ...(raw.visible !== undefined ? { visible: raw.visible as boolean } : {}) }
  need(raw.kind === undefined || raw.kind === v.kind, `${where}.kind: "${column}" draws as ${v.kind === 'vector' ? 'arrows ("vector")' : 'colors ("scalar")'}, so kind is ${v.kind}`)
  if (raw.style !== undefined) v = { ...v, style: readStyle(raw.style, v, where) } as VisualizationSpec
  return v
}

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
      need(isObj(raw) && str(raw.datasetId), `${where} needs name, datasetId, binding and column`)
      need(records.has(raw.datasetId), `${where}: dataset "${raw.datasetId}" isn't in datasetIds`)
      const v = await readVisualization(host, raw, where, cur.visualizations.find((x) => x.id === raw.id && x.datasetId === raw.datasetId))
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
  const assembled = assembleFiles(s.files, cur, newId, facts(host))
  if (!assembled.ok) return refused(assembled.errors)
  const { input: description, created, unused, datasetEdits } = assembled.value
  let built: { doc: WorkspaceDoc; errors: string[] }
  try {
    built = await buildWorkspace(host, cur, keepUnchanged(description, cur))
  } catch (e) {
    if (!(e instanceof Invalid)) throw e
    return refused([e.message])
  }
  if (built.errors.length) return refused(built.errors)
  const { doc } = built
  // Only what this chat made may go unasked: the user's own items stay unless they asked.
  need(input.userAsked === undefined || (Array.isArray(input.userAsked) && input.userAsked.every(str)), '`userAsked` must be a list of ids')
  const asked = new Set((input.userAsked as string[] | undefined) ?? [])
  const mine = made(host)
  const gone = [
    ...cur.datasetIds.filter((id) => !doc.datasetIds.includes(id)).map((id) => ({ id, what: `dataset "${host.record(id)?.name ?? id}"` })),
    ...cur.transforms.filter((t) => !doc.transforms.some((x) => x.id === t.id)).map((t) => ({ id: t.id, what: `transform "${t.name}"` })),
    ...cur.visualizations.filter((v) => !doc.visualizations.some((x) => x.id === v.id)).map((v) => ({ id: v.id, what: `visualization "${v.name}"` })),
  ].filter((g) => !mine.has(g.id) && !asked.has(g.id))
  if (gone.length)
    return refused(
      gone.map(
        (g) =>
          `This would remove ${g.what} (${g.id}), which you didn't make in this chat. Put it back in /workspace.json (view it and the overview again: it may have been added since you last looked); remove it only if the user asked for it by name, listing its id in userAsked.`,
      ),
    )
  const changes = [
    ...describeChanges(cur, doc),
    ...Object.entries(datasetEdits).map(([id, e]) => {
      const was = host.record(id)?.name ?? id
      return e.name ? `renamed dataset “${was}” → “${e.name}”${e.description !== undefined ? ' (and its description)' : ''}` : `described dataset “${was}”`
    }),
  ]
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
  for (const c of created) mine.add(c.id)
  for (const id of doc.datasetIds) if (!cur.datasetIds.includes(id)) mine.add(id)
  for (const [id, e] of Object.entries(datasetEdits)) {
    const r = host.updateDataset(id, e)
    if (!r.ok) return err(`The workspace changed, but dataset "${id}" wasn't renamed / described: ${r.message}`)
  }
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
    { ...result, ...(added.length ? { renamed: moved } : {}), ...undescribed(host), files: 'Rewritten from the workspace in the standard format: view a file before editing it.' },
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
  const r = await host.runTransform(t.id)
  if (!r.ok) return err(r.message, 'SQL error')
  for (const o of r.outputs) if (o.created) made(host).add(o.datasetId)
  // The facts for checking each stage, from each output's profile: rows against the inputs', keys, nulls, ranges, flags.
  const inputs = await Promise.all(t.inputs.map(async (i) => ({ alias: i.alias, record: await host.dataset(i.datasetId) })))
  const outputs = await Promise.all(
    r.outputs.map(async (o) => {
      const d = await host.dataset(o.datasetId)
      return { ...o, ...(d ? { check: outputCheck(d, inputs) } : {}) }
    }),
  )
  const flagged = outputs.reduce((n, o) => n + (o.check?.flags.length ?? 0), 0)
  return ok({ outputs, ...undescribed(host) }, `${r.outputs.map((o) => `${plural(o.rowCount, 'row')} → ${o.name}`).join(' · ')}${flagged ? ` · ${plural(flagged, 'flag')}` : ''}`)
}

async function deleteDataset(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  const d = await host.dataset(input.id)
  need(d, `No dataset "${input.id}"`)
  const pending = pendingEdits(host)
  if (pending) return pending
  const reader = host.doc().transforms.find((t) => t.inputs.some((i) => i.datasetId === d.id))
  if (reader) return err(`Transform "${reader.name}" reads "${d.name}"; change or remove that transform first.`, 'refused: still used')
  if (!made(host).has(d.id) && input.userAsked !== true)
    return err(`"${d.name}" isn't a dataset you made in this chat: delete it only if the user asked for it by name (then set userAsked).`, 'refused: not yours')
  const r = await host.deleteDataset(d.id)
  if (!r.ok) return err(r.message)
  return ok({ deleted: d.id }, `deleted ${d.name}`)
}

// ── ask_user ───────────────────────────────────────────────────────────────

async function askUser(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  const form = readForm(input)
  need(typeof form !== 'string', form as string)
  const a = await host.ask(form)
  return ok(a, answerSummary(form, a))
}

// ── add_builtin ────────────────────────────────────────────────────────────

async function addBuiltin(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.table) && input.table.trim(), '`table` is required')
  const known = host.builtins?.() ?? []
  const b = known.find((x) => x.table === input.table)
  if (!b || !host.addBuiltin) return err(`No built-in table "${input.table}"${known.length ? ` (there are: ${known.map((x) => x.table).join(', ')})` : ''}`)
  const r = await host.addBuiltin(b.table)
  if (!r.ok) return err(r.message)
  made(host).add(r.id)
  return ok({ datasetId: r.id, name: b.label }, `added ${b.label}`)
}

// ── send_scout / send_scraper ──────────────────────────────────────────────

/** Output files that become datasets: tables, and shapes. */
export const IMPORTABLE = /\.(csv|geojson)$/i
const PLACEHOLDER = 'not described yet'
/** A scraped file's description until the assistant writes one: when and what was asked for (the brief, trimmed). */
export function webFileDescription(day: string, sessionId: string, brief: string): string {
  const asked = brief.trim().replace(/\s+/g, ' ')
  return `From the web, ${day} (scraper run ${sessionId}), ${PLACEHOLDER}.\nAsked for: ${asked.length > 400 ? `${asked.slice(0, 400)}…` : asked}`
}

const money = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${n}`)
const nearestCap = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? WEB_CAPS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a)) : fallback)

async function sendWeb(host: AgentHost, role: WebRole, input: Obj): Promise<ToolOutcome> {
  need(str(input.brief) && input.brief.trim(), '`brief` is required')
  if (!host.web) return err('Sending the scout or scraper isn\'t available here.')
  const cap = nearestCap(input.cap_dollars, role === 'scout' ? 1 : 2)
  const Role = role === 'scout' ? 'scout' : 'scraper'
  const form: Form = {
    question: `Send the ${Role}?`,
    details:
      role === 'scout'
        ? 'It looks on the web and reports what data exists and how to get it; it fetches nothing. Edit the brief if you like.'
        : 'It fetches the data and makes the CSVs below; they become new datasets in your workspace. Edit the brief if you like.',
    fields: [
      { id: 'brief', kind: 'text', label: 'Brief', value: input.brief.trim(), multiline: true, required: true },
      { id: 'cap', kind: 'choice', label: 'Spending cap', options: WEB_CAPS.map(money), selected: [money(cap)], required: true },
      { id: 'notes', kind: 'text', label: 'Notes for the assistant', placeholder: 'Optional' },
    ],
    buttons: [`Send the ${Role}`, 'Not now'],
  }
  const a = await host.ask(form)
  const notes = typeof a.values.notes === 'string' && a.values.notes ? { notes: a.values.notes } : {}
  if (a.button !== form.buttons[0]) return ok({ sent: false, button: a.button, ...notes }, 'not sent')
  const brief = String(a.values.brief ?? '').trim() || input.brief.trim()
  const chosen = Array.isArray(a.values.cap) ? a.values.cap[0] : undefined
  const capDollars = WEB_CAPS.find((c) => money(c) === chosen) ?? cap
  const run = await host.web(role, brief, capDollars)
  if (typeof run === 'string') return err(run, `${Role} not sent`)
  const edited = brief !== input.brief.trim() ? { briefEditedByUser: brief } : {}
  const facts = { stop: run.stop, cost: run.cost, elapsedSeconds: run.elapsedSeconds, ...(run.missing?.length ? { filesThatNeverCameBack: run.missing } : {}), ...edited, ...notes }
  const head = `${run.stop === 'end_turn' ? 'finished' : run.stop} · ${Math.round(run.elapsedSeconds)} s${run.cost !== undefined ? ` · $${run.cost.toFixed(2)}` : ''}`
  if (role === 'scout') return ok({ report: run.report, ...facts }, head)
  // The scraper's CSVs become datasets; the rest (its script) stays with the run.
  const day = new Date().toISOString().slice(0, 10)
  const files = []
  for (const f of run.files) {
    if (!IMPORTABLE.test(f.name) || !host.importWebFile) {
      files.push({ name: f.name, bytes: f.bytes })
      continue
    }
    const r = await host.importWebFile(f.id, f.name, webFileDescription(day, run.sessionId, brief))
    if (r.ok) made(host).add(r.id)
    files.push(r.ok ? { name: f.name, datasetId: r.id } : { name: f.name, importError: r.message })
  }
  const imported = files.filter((f) => 'datasetId' in f).length
  return ok({ summary: run.report, files, ...facts }, `${head} · ${plural(imported, 'dataset')} added`)
}

// ── dispatch ───────────────────────────────────────────────────────────────

/** Runs a tool call: validated, gated, never throwing. */
async function tellStory(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(host.tellStory, 'The storyteller isn\'t available here')
  need(Array.isArray(input.visualizationIds) && input.visualizationIds.length && input.visualizationIds.every(str), '`visualizationIds` must list at least one visualization id')
  const doc = host.doc()
  const unknown = (input.visualizationIds as string[]).filter((id) => !doc.visualizations.some((v) => v.id === id))
  need(!unknown.length, `No visualization ${unknown.map((u) => `"${u}"`).join(', ')} in the workspace (get_workspace lists them)`)
  const storyId = str(input.storyId) && input.storyId ? input.storyId : undefined
  need(!storyId || (doc.stories ?? []).some((x) => x.id === storyId), `No story "${storyId}" to rewrite`)
  const r = await host.tellStory({ visualizationIds: input.visualizationIds as string[], wishes: str(input.wishes) ? input.wishes.trim() : '', ...(storyId ? { storyId } : {}) })
  if (typeof r === 'string') return err(r, 'not written')
  return ok({ ...r, note: 'The story is in the workspace draft (Stories, in the list view); the user saves it with the workspace.' }, `“${r.name}” · ${plural(r.scenes.length, 'scene')}`)
}

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
      case 'add_builtin':
        return await addBuiltin(host, input)
      case 'send_scout':
        return await sendWeb(host, 'scout', input)
      case 'send_scraper':
        return await sendWeb(host, 'scraper', input)
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
      case 'delete_dataset':
        return await deleteDataset(host, input)
      case 'tell_story':
        return await tellStory(host, input)
      default:
        return err(`Unknown tool "${name}"`)
    }
  } catch (e) {
    return e instanceof Invalid ? err(e.message, 'invalid input') : err(`The tool failed: ${(e as Error).message ?? String(e)}`, 'failed')
  }
}

// The workspace as the agent edits it: a few small files it navigates with
// Anthropic's text editor tool (view / create / str_replace / insert), which
// the model is trained on. Edits change only these staged files; the
// apply_workspace tool assembles them and checks the whole workspace before
// the draft changes (tools.ts).
//
//   workspace.json                    index: name, datasetIds, transform ids, visualization ids (draw order)
//   datasets.json                     the workspace's datasets by id: name and description (editable),
//                                     store, rows, origin (read-only)
//   transforms/<id>.json              one transform: name, inputs, outputs (key, name, outputId)
//   transforms/<id>.<key>.sql         that output's SQL, plain (found by name: no reference to get wrong)
//   visualizations/<id>.json          one visualization, compact
//   overview.md                       generated, read-only: one line per item
//
// An item's id is its file name. A new item gets a name the agent picks;
// applying gives it a real id. SQL is never written inside JSON.

import type { VisualizationSpec } from '../dataset/visualization'
import type { ColorEncoding } from '../style'
import type { TransformSpec, WorkspaceDoc } from '../workspace/workspace'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The editor tool's name (Anthropic's text editor, `text_editor_20250728`). */
export const EDITOR_TOOL = 'str_replace_based_edit_tool'

// ── items as the agent sees them ───────────────────────────────────────────

/** A color as the agent sees and writes it. */
export function agentColor(c: ColorEncoding): Obj {
  if (c.kind === 'colormap') return { kind: c.kind, colormap: c.colormap, ...(c.reverse ? { reverse: true } : {}), ...(c.scale === 'log' ? { scale: 'log' } : {}), ...(c.domain ? { domain: c.domain } : {}) }
  if (c.kind === 'categorical') return { kind: c.kind, ...(c.palette ? { palette: c.palette } : {}) }
  return { kind: c.kind, color: c.color }
}

/** A transform with its SQL inline: the shape the workspace checks read (and compare, to keep unchanged ones). */
export const agentTransform = (t: TransformSpec): Obj => ({
  id: t.id,
  name: t.name,
  inputs: t.inputs.map((i) => ({ datasetId: i.datasetId, alias: i.alias })),
  outputs: t.outputs.map((o) => ({ key: o.key, name: o.name, sql: o.sql, ...(o.outputId ? { outputId: o.outputId } : {}) })),
})

export const agentVisualization = (v: VisualizationSpec): Obj => ({
  id: v.id,
  name: v.name,
  datasetId: v.datasetId,
  geometry: v.binding.column,
  ...(v.binding.label ? { label: v.binding.label } : {}),
  column: v.column,
  aggregation: v.aggregation,
  visible: v.visible,
  color: agentColor(v.style.color),
  ...(v.kind === 'scalar' && v.style.opacity.kind === 'constant' ? { opacity: v.style.opacity.value } : {}),
})

/** JSON with keys in a fixed order, to tell whether an item changed. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

// ── the files ──────────────────────────────────────────────────────────────

/** Path → contents, paths without a leading slash. */
export type Files = Map<string, string>

export const INDEX = 'workspace.json'
export const DATASETS = 'datasets.json'
export const OVERVIEW = 'overview.md'
const NAME = '[A-Za-z0-9_-]+'
const TRANSFORM_FILE = new RegExp(`^transforms/(${NAME})\\.json$`)
const SQL_FILE = new RegExp(`^transforms/(${NAME})\\.(${NAME})\\.sql$`)
const VIZ_FILE = new RegExp(`^visualizations/(${NAME})\\.json$`)
const DIRS = ['transforms', 'visualizations']
const TRANSFORM_KEYS = ['name', 'inputs', 'outputs']
const OUTPUT_KEYS = ['key', 'name', 'outputId']
const VIZ_KEYS = ['name', 'datasetId', 'geometry', 'label', 'column', 'aggregation', 'visible', 'color', 'opacity']

const DATASET_KEYS = ['name', 'description', 'store', 'rows', 'origin']
const READ_ONLY = ['store', 'rows', 'origin'] as const

/** What datasets.json says about a dataset (the record as the page shows it: drafted names included). */
export interface DatasetFacts {
  name: string
  description?: string
  store?: 'local' | 'remote'
  rowCount?: number
  origin?: string
}
const datasetEntry = (d: DatasetFacts) => ({
  name: d.name,
  description: d.description ?? '',
  store: d.store === 'remote' ? 'cloud' : 'local',
  ...(d.rowCount !== undefined ? { rows: d.rowCount } : {}),
  ...(d.origin ? { origin: d.origin } : {}),
})

const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
export const transformPath = (id: string) => `transforms/${id}.json`
export const sqlPath = (id: string, key: string) => `transforms/${id}.${key}.sql`
export const vizPath = (id: string) => `visualizations/${id}.json`

/** The draft as files (`dataset` looks up what datasets.json says about each of its datasets). */
export function workspaceFiles(doc: WorkspaceDoc, dataset: (id: string) => DatasetFacts | undefined = () => undefined): Files {
  const files: Files = new Map()
  files.set(INDEX, pretty({ name: doc.name, datasetIds: doc.datasetIds, transforms: doc.transforms.map((t) => t.id), visualizations: doc.visualizations.map((v) => v.id) }))
  files.set(DATASETS, pretty(Object.fromEntries(doc.datasetIds.flatMap((id) => { const d = dataset(id); return d ? [[id, datasetEntry(d)]] : [] }))))
  for (const t of doc.transforms) {
    files.set(transformPath(t.id), pretty({ name: t.name, inputs: t.inputs.map((i) => ({ datasetId: i.datasetId, alias: i.alias })), outputs: t.outputs.map((o) => ({ key: o.key, name: o.name, ...(o.outputId ? { outputId: o.outputId } : {}) })) }))
    for (const o of t.outputs) files.set(sqlPath(t.id, o.key), o.sql.endsWith('\n') ? o.sql : `${o.sql}\n`)
  }
  for (const v of doc.visualizations) {
    const { id: _id, ...rest } = agentVisualization(v)
    files.set(vizPath(v.id), pretty(rest))
  }
  return files
}

/** A file the agent may write: the index, the datasets' details, a transform, an output's SQL, a visualization. */
export const writable = (path: string) => path === INDEX || path === DATASETS || TRANSFORM_FILE.test(path) || SQL_FILE.test(path) || VIZ_FILE.test(path)

// ── the editor (Anthropic's text editor commands, on the staged files) ─────

export type EditorResult = { ok: true; text: string; changed: boolean } | { ok: false; error: string }

const fail = (error: string): EditorResult => ({ ok: false, error })
const done = (text: string, changed = false): EditorResult => ({ ok: true, text, changed })

/** A path as the model writes it ("/transforms/x.json") → our key ("transforms/x.json"); null if it can't be one. */
function normalize(path: unknown): string | null {
  if (typeof path !== 'string') return null
  const p = path.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return p.split('/').some((s) => s === '..' || s === '.') ? null : p
}

const numbered = (text: string, from = 1) =>
  text
    .replace(/\n$/, '')
    .split('\n')
    .map((l, i) => `${String(i + from).padStart(6)}\t${l}`)
    .join('\n')

function listing(files: Files, dir: string): string {
  const paths = [...files.keys(), OVERVIEW].filter((p) => !dir || p.startsWith(`${dir}/`)).sort()
  return `Files in /${dir}:\n${paths.map((p) => `/${p}`).join('\n')}`
}

/**
 * For a .sql path under /transforms that isn't `<transform>.<output key>.sql` (or names a file that
 * doesn't exist): the rule, plus only facts taken from the files — never a guessed key or name.
 */
function sqlHint(files: Files, path: string): string | null {
  const m = /^transforms\/([^/]+?)(?:\.([^./]+))?\.sql$/.exec(path)
  if (!m) return null
  const rule = 'SQL files are named <transform>.<output key>.sql, one per output in the transform\'s JSON.'
  // The transform the agent likely meant: the whole stem, or the part before the last dot.
  const stems = [m[2] ? `${m[1]}.${m[2]}` : m[1], m[1]].filter((x, i, a) => a.indexOf(x) === i)
  for (const stem of stems) {
    const text = files.get(transformPath(stem))
    if (text === undefined) continue
    let keys: string[] = []
    try {
      const t = JSON.parse(text)
      keys = Array.isArray(t?.outputs) ? t.outputs.flatMap((o: unknown) => (isObj(o) && typeof o.key === 'string' ? [o.key] : [])) : []
    } catch {
      return `${rule} /${transformPath(stem)} isn't valid JSON right now, so its output keys can't be read.`
    }
    return keys.length
      ? `${rule} /${transformPath(stem)} has output key${keys.length > 1 ? 's' : ''} ${keys.map((k) => `"${k}"`).join(', ')}: ${keys.map((k) => `/${sqlPath(stem, k)}`).join(', ')}.`
      : `${rule} /${transformPath(stem)} has no output with a "key" yet.`
  }
  return `${rule} There is no /${transformPath(stems[stems.length - 1])}: a new transform needs its JSON file (each output with a "key" you choose) and one .sql file per output key, named after them; then list the transform in /workspace.json.`
}

/**
 * Runs one editor command on the files (changing them in place). `overview`
 * renders overview.md from the files as they are now.
 */
export function runEditor(files: Files, input: Obj, overview: () => string): EditorResult {
  const path = normalize(input.path)
  if (path === null) return fail('`path` must be a file path such as /workspace.json (no "." or "..").')
  const where = `/${path}`
  const known = () => `Files: ${['/', ...[...files.keys(), OVERVIEW].sort().map((p) => `/${p}`)].join(', ')}`
  switch (input.command) {
    case 'view': {
      if (path === '' || DIRS.includes(path)) return done(listing(files, path))
      const text = path === OVERVIEW ? overview() : files.get(path)
      if (text === undefined) return fail(`${where} does not exist. ${sqlHint(files, path) ?? known()}`)
      const range = input.view_range
      if (Array.isArray(range) && range.length === 2 && range.every(Number.isInteger)) {
        const lines = text.replace(/\n$/, '').split('\n')
        const [a, b] = range as number[]
        const end = b === -1 ? lines.length : b
        if (a < 1 || a > lines.length || end < a) return fail(`view_range ${JSON.stringify(range)} is outside ${where} (lines 1–${lines.length}).`)
        return done(numbered(lines.slice(a - 1, end).join('\n'), a))
      }
      return done(numbered(text))
    }
    case 'create': {
      if (typeof input.file_text !== 'string') return fail('`file_text` is required for create.')
      if (path === OVERVIEW) return fail(`${where} is generated from the other files and can't be edited; edit the item's own file instead.`)
      if (!writable(path)) {
        // A SQL file may come before its transform's JSON; only a name off the pattern is refused.
        const hint = sqlHint(files, path)
        if (hint) return fail(`Can't create ${where}. ${hint}`)
        return fail(`Can't create ${where}. Files are /workspace.json, /transforms/<id>.json, /transforms/<id>.<output key>.sql and /visualizations/<id>.json (ids: letters, digits, _ and -).`)
      }
      const before = files.get(path)
      files.set(path, input.file_text)
      return done(`${before === undefined ? 'Created' : 'Overwrote'} ${where}.`, before !== input.file_text)
    }
    case 'str_replace': {
      if (path === OVERVIEW) return fail(`${where} is generated from the other files and can't be edited; edit the item's own file instead.`)
      const text = files.get(path)
      if (text === undefined) return fail(`${where} does not exist. ${sqlHint(files, path) ?? known()}`)
      if (typeof input.old_str !== 'string' || !input.old_str) return fail('`old_str` is required for str_replace.')
      const next = typeof input.new_str === 'string' ? input.new_str : ''
      const parts = text.split(input.old_str)
      if (parts.length === 1) return fail(`No replacement was performed: old_str did not appear verbatim in ${where}. View the file and copy the text exactly (spaces and line breaks too).`)
      if (parts.length > 2) {
        const lines = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join(input.old_str as string).split('\n').length)
        return fail(`No replacement was performed: old_str occurs ${parts.length - 1} times in ${where} (lines ${lines.join(', ')}). Include more of the surrounding text so it occurs once.`)
      }
      files.set(path, parts.join(next))
      return done(`Edited ${where}.`, next !== input.old_str)
    }
    case 'insert': {
      if (path === OVERVIEW) return fail(`${where} is generated from the other files and can't be edited; edit the item's own file instead.`)
      const text = files.get(path)
      if (text === undefined) return fail(`${where} does not exist. ${known()}`)
      const add = typeof input.insert_text === 'string' ? input.insert_text : input.new_str
      if (typeof add !== 'string') return fail('`insert_text` is required for insert.')
      const lines = text.replace(/\n$/, '').split('\n')
      const at = input.insert_line
      if (!Number.isInteger(at) || (at as number) < 0 || (at as number) > lines.length) return fail(`insert_line must be between 0 and ${lines.length} for ${where}.`)
      lines.splice(at as number, 0, ...add.replace(/\n$/, '').split('\n'))
      files.set(path, `${lines.join('\n')}\n`)
      return done(`Inserted into ${where} after line ${at}.`, true)
    }
    default:
      return fail(`Unknown command ${JSON.stringify(input.command)}: use view, create, str_replace or insert.`)
  }
}

// ── assembling the files back into a workspace ─────────────────────────────

export interface Assembled {
  /** A full workspace description (items with ids, SQL inline) for the workspace checks. */
  input: Obj
  /** New items: the name the agent gave them → their id. */
  created: { kind: 'transform' | 'visualization'; file: string; id: string }[]
  /** Files no listed item uses (dropped). */
  unused: string[]
  /** Datasets whose name / description datasets.json changes: id → the new values. */
  datasetEdits: Record<string, { name?: string; description?: string }>
}

function parseJson(files: Files, path: string, errors: string[]): Obj | null {
  const text = files.get(path)
  if (text === undefined) return void errors.push(`/${path} is missing (create it, or take its id out of /workspace.json)`), null
  try {
    const v = JSON.parse(text)
    if (isObj(v)) return v
    errors.push(`/${path} must hold a JSON object`)
  } catch (e) {
    errors.push(`/${path} isn't valid JSON (${(e as Error).message}); check commas, brackets and quotes`)
  }
  return null
}

function unknownKeys(o: Obj, allowed: string[], where: string, errors: string[]) {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue
    if (k === 'sql') errors.push(`${where}: SQL doesn't go in the JSON — it lives in /transforms/<id>.<output key>.sql`)
    else if (k === 'id') errors.push(`${where}: no "id" inside the file — the file name is the id`)
    else errors.push(`${where}: unknown field "${k}" (fields: ${allowed.join(', ')})`)
  }
}

const idList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * The files as one workspace description, with every problem listed. Items
 * named by ids the draft doesn't have are new and get a fresh id (`newId`).
 */
export function assembleFiles(
  files: Files,
  doc: WorkspaceDoc,
  newId: () => string,
  dataset: (id: string) => DatasetFacts | undefined = () => undefined,
): { ok: true; value: Assembled } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const index = parseJson(files, INDEX, errors)
  if (!index) return { ok: false, errors }
  unknownKeys(index, ['name', 'datasetIds', 'transforms', 'visualizations'], '/workspace.json', errors)
  for (const k of ['datasetIds', 'transforms', 'visualizations']) if (!idList(index[k])) errors.push(`/workspace.json: "${k}" must be a list of ids (it can be empty)`)
  if (index.name !== undefined && typeof index.name !== 'string') errors.push('/workspace.json: "name" must be text')
  if (errors.length) return { ok: false, errors }
  const used = new Set([INDEX])
  const created: Assembled['created'] = []
  const idFor = (kind: 'transform' | 'visualization', name: string, existing: boolean) => {
    if (existing) return name
    const id = newId()
    created.push({ kind, file: name, id })
    return id
  }
  const dupes = (list: string[], what: string) => {
    const seen = new Set<string>()
    for (const x of list) {
      if (seen.has(x)) errors.push(`/workspace.json: ${what} "${x}" is listed twice`)
      seen.add(x)
    }
  }
  dupes(index.datasetIds as string[], 'dataset')
  dupes(index.transforms as string[], 'transform')
  dupes(index.visualizations as string[], 'visualization')

  const transforms = (index.transforms as string[]).flatMap((name) => {
    const path = transformPath(name)
    if (!new RegExp(`^${NAME}$`).test(name)) return errors.push(`/workspace.json: transform "${name}" can't be a file name (letters, digits, _ and -)`), []
    used.add(path)
    const t = parseJson(files, path, errors)
    if (!t) return []
    unknownKeys(t, TRANSFORM_KEYS, `/${path}`, errors)
    if (!Array.isArray(t.outputs)) return errors.push(`/${path}: "outputs" must be a list`), []
    const outputs = t.outputs.flatMap((o: unknown, i: number) => {
      const w = `/${path} outputs[${i}]`
      if (!isObj(o)) return errors.push(`${w} must be an object`), []
      unknownKeys(o, OUTPUT_KEYS, w, errors)
      if (typeof o.key !== 'string' || !new RegExp(`^${NAME}$`).test(o.key)) return errors.push(`${w} needs a "key" (letters, digits, _ and -): its SQL is /transforms/${name}.<key>.sql`), []
      const sql = files.get(sqlPath(name, o.key))
      used.add(sqlPath(name, o.key))
      if (sql === undefined) return errors.push(`${w}: its SQL file /${sqlPath(name, o.key)} is missing`), []
      return [{ ...o, sql: sql.replace(/\n+$/, '') }]
    })
    return [{ ...t, outputs, id: idFor('transform', name, doc.transforms.some((x) => x.id === name)) }]
  })

  const visualizations = (index.visualizations as string[]).flatMap((name) => {
    const path = vizPath(name)
    if (!new RegExp(`^${NAME}$`).test(name)) return errors.push(`/workspace.json: visualization "${name}" can't be a file name (letters, digits, _ and -)`), []
    used.add(path)
    const v = parseJson(files, path, errors)
    if (!v) return []
    unknownKeys(v, VIZ_KEYS, `/${path}`, errors)
    return [{ ...v, id: idFor('visualization', name, doc.visualizations.some((x) => x.id === name)) }]
  })

  // datasets.json: name and description change (as a draft, like the rest); the other facts are read-only.
  const datasetEdits: Assembled['datasetEdits'] = {}
  if (files.has(DATASETS)) {
    used.add(DATASETS)
    const all = parseJson(files, DATASETS, errors) ?? {}
    for (const [id, e] of Object.entries(all)) {
      const w = `/${DATASETS} "${id}"`
      const d = dataset(id)
      if (!(index.datasetIds as string[]).includes(id) || !d) {
        errors.push(`${w}: not a dataset of this workspace (only those listed in /workspace.json "datasetIds" are here; add one there first)`)
        continue
      }
      if (!isObj(e)) {
        errors.push(`${w} must be an object`)
        continue
      }
      unknownKeys(e, DATASET_KEYS, w, errors)
      const was = datasetEntry(d) as Obj
      for (const k of READ_ONLY) if (e[k] !== undefined && canonical(e[k]) !== canonical(was[k])) errors.push(`${w}: "${k}" is read-only (it says ${JSON.stringify(was[k])})`)
      if (e.name !== undefined && (typeof e.name !== 'string' || !e.name.trim())) errors.push(`${w}: "name" must be non-empty text`)
      if (e.description !== undefined && typeof e.description !== 'string') errors.push(`${w}: "description" must be text`)
      const patch = {
        ...(typeof e.name === 'string' && e.name.trim() !== d.name ? { name: e.name.trim() } : {}),
        ...(typeof e.description === 'string' && e.description.trim() !== (d.description ?? '') ? { description: e.description.trim() } : {}),
      }
      if (!Object.keys(patch).length) continue
      datasetEdits[id] = patch
    }
  }

  if (errors.length) return { ok: false, errors }
  const unused = [...files.keys()].filter((p) => !used.has(p)).sort()
  return { ok: true, value: { input: { name: index.name, datasetIds: index.datasetIds, transforms, visualizations }, created, unused, datasetEdits } }
}

// ── the overview ───────────────────────────────────────────────────────────

export interface OverviewInfo {
  version: string
  datasets: { id: string; name: string; store?: string; rows?: number; origin?: string; description?: string }[]
  /** A saved transform's state (ready / not-run / stale), by id. */
  state(transformId: string): string | undefined
  /** True when the files differ from the draft (edits not applied yet). */
  pending: boolean
}

/**
 * How the files work, at the top of every overview: the editor's own description is Anthropic's,
 * so this (and the prompt) is where the model learns the layout. Rules plus a labelled example
 * only — nothing here is a suggestion about the current workspace.
 */
const GUIDE = [
  '## How these files work',
  '- /workspace.json lists what exists: "datasetIds", "transforms" and "visualizations" (ids; visualizations in draw order, first on top).',
  '- /datasets.json holds each workspace dataset by id: "name" and "description" you can change (give datasets you make a clear name and a one-line description); "store", "rows" and "origin" are read-only.',
  '- /transforms/<id>.json is one transform: {"name", "inputs": [{"datasetId", "alias"}], "outputs": [{"key", "name", "outputId"?}]}.',
  '- /transforms/<id>.<output key>.sql is one output\'s SQL, plain text. SQL never goes inside JSON.',
  '- /visualizations/<id>.json is one visualization. A file\'s name is its id.',
  '- Example (placeholder names): to add a transform, create /transforms/by_state.json with outputs [{"key": "o1", "name": "State values"}], create /transforms/by_state.o1.sql, add "by_state" to "transforms" in /workspace.json, then apply_workspace; its reply gives the real id.',
  '- To remove an item, take its id out of /workspace.json. Nothing changes until apply_workspace.',
]

/** overview.md: one line per item, from the files as they are now (pending edits included). */
export function overviewText(files: Files, doc: WorkspaceDoc, info: OverviewInfo): string {
  const lines: string[] = []
  let index: Obj = {}
  try {
    const v = JSON.parse(files.get(INDEX) ?? '')
    if (isObj(v)) index = v
  } catch {
    lines.push('⚠ /workspace.json is not valid JSON right now.', '')
  }
  const list = (k: string) => (idList(index[k]) ? (index[k] as string[]) : [])
  const read = (path: string): Obj | null => {
    try {
      const v = JSON.parse(files.get(path) ?? '')
      return isObj(v) ? v : null
    } catch {
      return null
    }
  }
  const dsName = new Map(info.datasets.map((d) => [d.id, d.name]))
  const ds = (id: unknown) => (typeof id === 'string' ? (dsName.has(id) ? `${id} (${dsName.get(id)})` : id) : '?')

  lines.push(`# Workspace "${typeof index.name === 'string' ? index.name : doc.name}" · version ${info.version}${info.pending ? ' · edits not applied yet (apply_workspace)' : ''}`, '')
  lines.push(...GUIDE, '')
  const dsIds = list('datasetIds')
  lines.push(`## Datasets (${dsIds.length})`)
  for (const id of dsIds) {
    const d = info.datasets.find((x) => x.id === id)
    lines.push(d ? `- ${id}  "${d.name}"  ${[d.store, d.rows !== undefined ? `${d.rows.toLocaleString()} rows` : '', d.origin].filter(Boolean).join(' · ')}${d.description ? `\n    ${d.description}` : ''}` : `- ${id}  (missing on this device)`)
  }
  const trs = list('transforms')
  lines.push('', `## Transforms (${trs.length})`)
  for (const id of trs) {
    const t = read(transformPath(id))
    const saved = doc.transforms.some((x) => x.id === id)
    if (!t) {
      lines.push(`- ${id}  ⚠ /${transformPath(id)} is missing or not valid JSON`)
      continue
    }
    lines.push(`- ${id}  "${t.name}"  ${saved ? (info.state(id) ?? '') : 'new (not applied)'}`)
    if (Array.isArray(t.inputs)) lines.push(`    inputs: ${t.inputs.map((i) => (isObj(i) ? `${i.alias} = ${ds(i.datasetId)}` : '?')).join(', ') || 'none'}`)
    if (Array.isArray(t.outputs)) {
      for (const o of t.outputs) {
        if (!isObj(o)) continue
        const sql = typeof o.key === 'string' ? files.get(sqlPath(id, o.key)) : undefined
        lines.push(`    output ${o.key}: "${o.name}" → ${o.outputId ? ds(o.outputId) : 'a new dataset on first run'}  (SQL: /${sqlPath(id, String(o.key))}${sql === undefined ? ' — missing' : `, ${sql.replace(/\n+$/, '').split('\n').length} lines`})`)
      }
    }
  }
  const vzs = list('visualizations')
  lines.push('', `## Visualizations (${vzs.length}; the first draws on top)`)
  for (const id of vzs) {
    const v = read(vizPath(id))
    if (!v) {
      lines.push(`- ${id}  ⚠ /${vizPath(id)} is missing or not valid JSON`)
      continue
    }
    const color = isObj(v.color) ? [v.color.kind, v.color.colormap ?? v.color.palette ?? v.color.color, v.color.scale === 'log' ? 'log' : ''].filter(Boolean).join(' ') : 'default color'
    const isNew = !doc.visualizations.some((x) => x.id === id)
    lines.push(`- ${id}  "${v.name}"  ${ds(v.datasetId)} · geometry ${v.geometry} · ${v.column}${v.aggregation ? ` (${v.aggregation})` : ''} · ${color}${v.visible === false ? ' · hidden' : ''}${isNew ? ' · new (not applied)' : ''}`)
  }
  lines.push('', `Files: ${[...files.keys()].sort().map((p) => `/${p}`).join(' · ')}`)
  return lines.join('\n')
}

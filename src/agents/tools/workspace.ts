// The workspace as files: read them, edit them, apply them; run a transform.
// Each tool: its spec (what the model sees) next to its handler (what runs).

import { type DatasetRecord } from '../../shared/records'
import { aggregationsFor, defaultAggregation, type Aggregation } from '../../lib/dataset/aggregate'
import type { GeometryBinding } from '../../lib/dataset/binding'
import { columnType, makeVisualization, retarget, ROWS, VALUE, type VisualizationSpec } from '../../lib/dataset/visualization'
import { newId } from '../../lib/dataset/dataset'
import { COLORMAPS, type ColormapName } from '../../lib/colormaps'
import type { PaletteName } from '../../lib/palettes'
import { MAGNITUDE_FIELD, PATTERNS, type ColorEncoding, type OpacityEncoding, type PatternEncoding, type PatternKind, type ScalarStyle, type VectorStyle } from '../../lib/style'
import { addDataset, addTransform, addVisualization, newOutput, setAbout, type DatasetEdit, type OpContext, type TransformSpec, type WorkspaceDoc } from '../../lib/workspace/workspace'
import { outputCheck } from '../../lib/agent/checks'
import { transformState } from '../../lib/workspace/dag'
import { datasetFact } from '../../lib/workspace/file'
import type { ToolOutcome } from '../../lib/agent/loop'
import { agentTransform, agentVisualization, assembleFiles, canonical, EDITOR_TOOL, OVERVIEW, overviewText, runEditor, sqlPath, transformPath, vizPath, workspaceFiles, type DatasetFacts, type Files } from '../../lib/agent/workspaceFiles'
import type { ToolSpec } from '../../lib/agent/provider'
import { AGG_NAMES, Invalid, Obj, PALETTES, PLACEHOLDER, err, isObj, need, ok, optStr, plural, storeLabel, str, workspaceVersion } from './common'
import { AgentHost } from './host'
import { readInputs } from './query'

export const WORKSPACE_TOOLS: ToolSpec[] = [
  {
    name: 'get_workspace',
    description:
      "Where to start, and how to see the user's changes: (re)builds the workspace files you edit with the text editor (discarding edits you haven't applied) and returns /overview.md — every dataset, transform and visualization with its id, one line each. The files: /workspace.json (name, datasetIds, transform ids, visualization ids in draw order), /transforms/<id>.json (name, inputs, outputs), /transforms/<id>.<output key>.sql (that output's SQL, plain), /visualizations/<id>.json. View only the files you need.",
    inputSchema: { type: 'object', properties: {} },
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
    strict: true,
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
    name: 'run_transform',
    description:
      'Run one transform of the workspace (its current SQL): every output is written, or none if any SQL fails. New output datasets join the workspace (without visualizations). Returns, per output, its dataset id and a check: its rows and each input\'s, the columns unique on every row (keys), each column\'s nulls, distinct values and range, and flags worth a look (more rows than any input, no unique column, an empty column). It changes this device\'s copies only: an output linked to the cloud turns ↑ (changed here) until the user syncs it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
]

/**
 * The files the agent edits, per chat host: built from the draft at
 * get_workspace (and whenever they hold no pending edits and the draft
 * moved on); `base` is the draft version they were built from.
 */
export interface Staging {
  files: Files
  base: string
  dirty: boolean
}

export const staging = new WeakMap<AgentHost, Staging>()

/** Files an apply renamed (a new item's placeholder name → its id), per host: old path → what it became. */
/** What the agent made in this chat (transforms, visualizations, datasets, datasets it brought in): only these it may remove unasked. */
export const madeHere = new WeakMap<AgentHost, Set<string>>()

export const made = (host: AgentHost) => madeHere.get(host) ?? (madeHere.set(host, new Set()), madeHere.get(host)!)

/** Datasets this chat made, still in the workspace, with no description (or a bare line): the next person has nothing else to go on. */
export const BRIEF = 80

export function undescribed(host: AgentHost): Obj {
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

/**
 * Datasets brought in from the web (the import note says "not described yet") that this apply leaves without a
 * description of their own and a source in their metadata: why each one is refused. Gone from the workspace = fine.
 */
export function notDescribed(host: Pick<AgentHost, 'record'>, ids: string[], edits: Record<string, DatasetEdit>): string[] {
  return ids.flatMap((id) => {
    const d = host.record(id)
    if (!d?.description?.includes(PLACEHOLDER)) return []
    const e = edits[id] ?? {}
    const description = (e.description ?? d.description ?? '').trim()
    const metadata = e.metadata === undefined ? d.metadata : e.metadata
    const missing = [
      (!description || description.includes(PLACEHOLDER)) && 'a description (plain language, replacing the import note)',
      !metadata?.source?.publisher && 'its metadata with the source (publisher, title, urls, period, coverage, terms, method)',
    ].filter(Boolean)
    return missing.length
      ? [`"${d.name}" (${id}) came from the web and isn't described yet: give it ${missing.join(' and ')} in /datasets.json, from the scout's and scraper's reports and your own queries of it (see Describing datasets), in this apply or before it. Or take it out of /workspace.json.`]
      : []
  })
}

/** A new chat starts afresh: no staged files, nothing made yet. */
export function forgetChat(host: AgentHost) {
  staging.delete(host)
  renames.delete(host)
  madeHere.delete(host)
}

export const renames = new WeakMap<AgentHost, Map<string, { path: string; kind: string; id: string }>>()

/** What datasets.json says about the workspace's datasets. */
export const facts = (host: AgentHost) => (id: string): DatasetFacts | undefined => {
  const d = host.record(id)
  if (!d) return undefined
  const { id: _id, ...fact } = datasetFact(id, d, host.doc().transforms)
  return fact
}

/** The host's files, rebuilt from the draft when nothing is pending and the draft changed. */
export function staged(host: AgentHost, fresh = false): Staging {
  const version = workspaceVersion(host.doc())
  const s = staging.get(host)
  if (s && !fresh && (s.dirty || s.base === version)) return s
  const next = { files: workspaceFiles(host.doc(), facts(host)), base: version, dirty: false }
  staging.set(host, next)
  return next
}

/** A refusal while edits are pending: tools that change the draft would act on the old version. */
export function pendingEdits(host: AgentHost): ToolOutcome | null {
  return staging.get(host)?.dirty ? err('You have edits to the workspace files that are not applied. Call apply_workspace first (or get_workspace to discard them).', 'refused: edits not applied') : null
}

export async function renderOverview(host: AgentHost, s: Staging): Promise<string> {
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

export async function getWorkspace(host: AgentHost): Promise<ToolOutcome> {
  const discarded = staging.get(host)?.dirty
  const s = staged(host, true)
  const doc = host.doc()
  const text = `${discarded ? '(Your edits that were not applied have been discarded.)\n\n' : ''}${await renderOverview(host, s)}`
  return { content: text, isError: false, summary: `${plural(doc.datasetIds.length, 'dataset')} · ${plural(doc.transforms.length, 'transform')} · ${plural(doc.visualizations.length, 'visualization')}` }
}

export async function editor(host: AgentHost, input: Obj): Promise<ToolOutcome> {
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

export function readColor(v: unknown, kind: VisualizationSpec['kind'], where: string): ColorEncoding | undefined {
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

export const hex = (c: unknown, where: string): string => {
  need(str(c) && /^#[0-9a-f]{6}$/i.test(c), `${where} must be a hex color like #3b82f6`)
  return c
}

export const unit = (x: unknown, where: string): number => {
  need(typeof x === 'number' && x >= 0 && x <= 1, `${where} must be between 0 and 1`)
  return x
}

export const range = (d: unknown, where: string): [number, number] => {
  need(Array.isArray(d) && d.length === 2 && d.every((x) => typeof x === 'number' && Number.isFinite(x)) && d[0] < d[1], `${where} must be [min, max] with min < max`)
  return [d[0], d[1]]
}

export function allowed(o: Obj, keys: string[], where: string) {
  for (const k of Object.keys(o)) need(keys.includes(k), `${where}: unknown field "${k}" (fields: ${keys.join(', ')})`)
}

export function readOpacity(v: unknown, field: string, where: string): OpacityEncoding {
  need(isObj(v), `${where}.opacity must be {"kind": "constant", "value"} or {"kind": "field", "range", "domain"?}`)
  if (v.kind === 'constant') return { kind: 'constant', value: unit(v.value, `${where}.opacity.value`) }
  need(v.kind === 'field', `${where}.opacity.kind must be constant or field`)
  const r = range(v.range, `${where}.opacity.range`)
  unit(r[0], `${where}.opacity.range`), unit(r[1], `${where}.opacity.range`)
  return { kind: 'field', field, range: r, ...(v.domain !== undefined ? { domain: range(v.domain, `${where}.opacity.domain`) } : {}) }
}

export function readPattern(v: unknown, where: string): PatternEncoding {
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
export function readStyle(raw: unknown, v: VisualizationSpec, where: string): VisualizationSpec['style'] {
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

export async function buildWorkspace(host: AgentHost, cur: WorkspaceDoc, input: Obj): Promise<{ doc: WorkspaceDoc; errors: string[] }> {
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
      need(optStr(raw.description), `${where}.description must be text`)
      const t: TransformSpec = { id: (raw.id as string | undefined) ?? newId(), name: raw.name, ...(str(raw.description) && raw.description.trim() ? { description: raw.description.trim() } : {}), inputs, outputs }
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
export function keepUnchanged(input: Obj, cur: WorkspaceDoc): Obj {
  const same = <T extends { id: string }>(list: unknown, items: T[], show: (x: T) => unknown) => {
    if (!Array.isArray(list)) return list
    const shown = new Map(items.map((x) => [x.id, canonical(show(x))]))
    return list.map((raw) => (isObj(raw) && str(raw.id) && shown.get(raw.id) === canonical(raw) ? { id: raw.id } : raw))
  }
  return { ...input, transforms: same(input.transforms, cur.transforms, agentTransform), visualizations: same(input.visualizations, cur.visualizations, agentVisualization) }
}

/** What changed between two workspaces, an item a line. */
export function describeChanges(a: WorkspaceDoc, b: WorkspaceDoc): string[] {
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

export async function applyWorkspace(host: AgentHost, input: Obj): Promise<ToolOutcome> {
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
  const { input: description, created, unused, datasetEdits, about } = assembled.value
  let built: { doc: WorkspaceDoc; errors: string[] }
  try {
    built = await buildWorkspace(host, cur, keepUnchanged(description, cur))
  } catch (e) {
    if (!(e instanceof Invalid)) throw e
    return refused([e.message])
  }
  if (built.errors.length) return refused(built.errors)
  // Data from the web is described before anything is built on it: by the assistant, which has the runs' reports and can query it.
  const waiting = notDescribed(host, built.doc.datasetIds, datasetEdits)
  if (waiting.length) return refused(waiting)
  const doc = about === undefined ? built.doc : (setAbout(built.doc, about) as { ok: true; doc: WorkspaceDoc }).doc
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
    ...(about === undefined ? [] : [about ? 'updated About (/about.md)' : 'cleared About (/about.md)']),
    ...Object.entries(datasetEdits).map(([id, e]) => {
      const was = host.record(id)?.name ?? id
      const parts = [e.description !== undefined && 'description', e.metadata !== undefined && 'metadata', e.notes !== undefined && 'notes'].filter(Boolean).join(', ')
      return e.name ? `renamed dataset “${was}” → “${e.name}”${parts ? ` (and its ${parts})` : ''}` : `updated dataset “${was}”: ${parts}`
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

export async function runTransform(host: AgentHost, input: Obj): Promise<ToolOutcome> {
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

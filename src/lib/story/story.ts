// Stories: how a workspace gets from its starting data to the maps, told in
// scenes. A story is a few kilobytes of text and specs saved with the workspace
// (draft, undo, Save, files, the account): every figure is code — SQL over the
// workspace's datasets, or a visualization's settings — drawn when the story
// opens. Each figure keeps a small snapshot of what it showed when the story was
// written, so the story reads before the engine loads, and a figure whose data
// has changed since is marked (its narrative may quote numbers that no longer hold).
//
// A scene is meant to be understood in under 30 seconds: a short narrative (about
// 80 words, the length read aloud in that time) and at most two figures.

import type { VisualizationSpec } from '../dataset/visualization'

/** Words a narrative should keep to (≈ 30 s read aloud), and the most it may have. */
export const NARRATIVE_WORDS = 80
export const MAX_NARRATIVE_WORDS = 120
export const MAX_SCENES = 14
export const MAX_FIGURES = 2
/** Rows a sample shows; rows a chart's snapshot keeps. */
export const SAMPLE_ROWS = 8
export const CHART_ROWS = 60

export type ChartKind = 'bar' | 'pie' | 'line' | 'scatter' | 'histogram'
export const CHART_KINDS: ChartKind[] = ['bar', 'pie', 'line', 'scatter', 'histogram']

/** What a SQL figure showed when the story was written (columns, then rows of cells). */
export interface Snapshot {
  columns: string[]
  rows: unknown[][]
}

/** SQL over workspace datasets, each by its alias (as in a transform). */
export interface SqlSource {
  sql: string
  inputs: { datasetId: string; alias: string }[]
}

export type Figure =
  | ({ kind: 'sample'; caption?: string; snapshot?: Snapshot } & SqlSource)
  | ({ kind: 'chart'; chart: ChartKind; x: string; y?: string; caption?: string; snapshot?: Snapshot } & SqlSource)
  | {
      kind: 'map'
      /** The visualization drawn (its settings; not one of the workspace's list). */
      viz: Omit<VisualizationSpec, 'id' | 'visible'>
      /** Feature names left off the map (e.g. far-off territories). */
      hide?: string[]
      /** `main`: fit the main group of features (far-off ones out of view); `all`: every feature drawn. */
      fit?: 'main' | 'all'
      caption?: string
    }

export interface Scene {
  id: string
  title: string
  /** Plain text, light markdown (**bold**, *italic*, lists). Read aloud later. */
  narrative: string
  /** What the scene is about (a dataset, transform or visualization of the workspace). */
  about?: { kind: 'dataset' | 'transform' | 'visualization'; id: string }
  figures: Figure[]
}

export interface Story {
  id: string
  name: string
  /** The visualizations the story was asked to tell. */
  visualizationIds: string[]
  /** ISO time it was written. */
  writtenAt: string
  scenes: Scene[]
}

export const words = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,%$-]*/gu) ?? []).length

/** Seconds to read a narrative aloud (about 160 words a minute). */
export const readSeconds = (text: string) => Math.round((words(text) / 160) * 60)

// ── checking a story (what the storyteller writes, and what files carry) ─────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'

function readSource(o: Obj, where: string, errors: string[]): SqlSource | null {
  if (!str(o.sql) || !o.sql.trim()) {
    errors.push(`${where}: needs sql (one SELECT)`)
    return null
  }
  const inputs = Array.isArray(o.inputs) ? o.inputs : []
  if (!inputs.every((i) => isObj(i) && str(i.datasetId) && str(i.alias) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(i.alias))) {
    errors.push(`${where}.inputs: each needs datasetId and alias (a plain SQL name)`)
    return null
  }
  return { sql: o.sql.trim(), inputs: inputs.map((i) => ({ datasetId: (i as Obj).datasetId as string, alias: (i as Obj).alias as string })) }
}

function readSnapshot(v: unknown): Snapshot | undefined {
  if (!isObj(v) || !Array.isArray(v.columns) || !v.columns.every(str) || !Array.isArray(v.rows) || !v.rows.every(Array.isArray)) return undefined
  return { columns: v.columns as string[], rows: v.rows as unknown[][] }
}

const caption = (o: Obj) => (str(o.caption) && o.caption.trim() ? { caption: o.caption.trim() } : {})

/** One figure, checked; null (with the reason in `errors`) when it isn't one. Map settings are checked by whoever draws them. */
export function readFigure(v: unknown, where: string, errors: string[]): Figure | null {
  if (!isObj(v)) {
    errors.push(`${where} must be an object`)
    return null
  }
  if (v.kind === 'sample') {
    const s = readSource(v, where, errors)
    const snap = readSnapshot(v.snapshot)
    return s && { kind: 'sample', ...s, ...caption(v), ...(snap ? { snapshot: snap } : {}) }
  }
  if (v.kind === 'chart') {
    const s = readSource(v, where, errors)
    if (!CHART_KINDS.includes(v.chart as ChartKind)) errors.push(`${where}.chart must be one of ${CHART_KINDS.join(', ')}`)
    else if (!str(v.x) || !v.x) errors.push(`${where}: needs x (a column of its SQL's result)`)
    else if (v.chart !== 'histogram' && (!str(v.y) || !v.y)) errors.push(`${where}: a ${v.chart} chart needs y (a numeric column of its SQL's result)`)
    else if (s) {
      const snap = readSnapshot(v.snapshot)
      return { kind: 'chart', chart: v.chart as ChartKind, x: v.x, ...(str(v.y) && v.y ? { y: v.y } : {}), ...s, ...caption(v), ...(snap ? { snapshot: snap } : {}) }
    }
    return null
  }
  if (v.kind === 'map') {
    const viz = v.viz
    if (!isObj(viz) || !str(viz.datasetId) || !str(viz.column) || !isObj(viz.binding) || !isObj(viz.style)) {
      errors.push(`${where}.viz: needs a visualization's settings (datasetId, binding, column, aggregation, style)`)
      return null
    }
    const hide = Array.isArray(v.hide) ? v.hide.filter(str) : []
    return {
      kind: 'map',
      viz: viz as unknown as Omit<VisualizationSpec, 'id' | 'visible'>,
      ...(hide.length ? { hide } : {}),
      ...(v.fit === 'all' ? { fit: 'all' as const } : {}),
      ...caption(v),
    }
  }
  errors.push(`${where}.kind must be sample, chart or map`)
  return null
}

/**
 * A story from a file or the storyteller, checked: every scene a title, a narrative of at most
 * MAX_NARRATIVE_WORDS words and at most MAX_FIGURES figures; at most MAX_SCENES scenes.
 */
export function readStory(v: unknown, errors: string[] = []): Story | null {
  if (!isObj(v) || !str(v.id) || !str(v.name) || !Array.isArray(v.scenes)) {
    errors.push('a story needs id, name and scenes')
    return null
  }
  if (!v.scenes.length) errors.push('a story needs at least one scene')
  if (v.scenes.length > MAX_SCENES) errors.push(`at most ${MAX_SCENES} scenes (group small steps into one)`)
  const scenes: Scene[] = []
  for (const [n, s] of v.scenes.entries()) {
    const where = `scenes[${n}]`
    if (!isObj(s) || !str(s.title) || !s.title.trim() || !str(s.narrative) || !s.narrative.trim()) {
      errors.push(`${where}: needs a title and a narrative`)
      continue
    }
    const w = words(s.narrative)
    if (w > MAX_NARRATIVE_WORDS) errors.push(`${where} "${s.title}": the narrative has ${w} words; keep it to about ${NARRATIVE_WORDS} (at most ${MAX_NARRATIVE_WORDS})`)
    const raw = Array.isArray(s.figures) ? s.figures : []
    if (raw.length > MAX_FIGURES) errors.push(`${where} "${s.title}": at most ${MAX_FIGURES} figures`)
    const figures = raw.slice(0, MAX_FIGURES).flatMap((f, i) => readFigure(f, `${where}.figures[${i}]`, errors) ?? [])
    const a = s.about
    const about = isObj(a) && ['dataset', 'transform', 'visualization'].includes(a.kind as string) && str(a.id) ? { kind: a.kind as 'dataset', id: a.id } : undefined
    scenes.push({ id: str(s.id) ? s.id : `s${n + 1}`, title: s.title.trim(), narrative: s.narrative.trim(), ...(about ? { about } : {}), figures })
  }
  return {
    id: v.id,
    name: v.name.trim() || 'Story',
    visualizationIds: Array.isArray(v.visualizationIds) ? v.visualizationIds.filter(str) : [],
    writtenAt: str(v.writtenAt) ? v.writtenAt : new Date(0).toISOString(),
    scenes,
  }
}

/** Stories from a file (anything that isn't one is dropped). */
export function readStories(v: unknown): Story[] {
  return Array.isArray(v) ? v.flatMap((s) => readStory(s) ?? []) : []
}

/** Snapshot of a query's result: its columns and up to `max` rows. */
export function snapshotOf(columns: string[], rows: Record<string, unknown>[], max: number): Snapshot {
  return { columns, rows: rows.slice(0, max).map((r) => columns.map((c) => r[c] ?? null)) }
}

/** Whether a figure's data now differs from its snapshot (the narrative may quote old numbers). */
export function snapshotChanged(was: Snapshot | undefined, now: Snapshot): boolean {
  return !!was && JSON.stringify(was) !== JSON.stringify(now)
}

/** The datasets a story's figures read. */
export function storyDatasets(s: Story): string[] {
  return [...new Set(s.scenes.flatMap((sc) => sc.figures.flatMap((f) => (f.kind === 'map' ? [f.viz.datasetId] : f.inputs.map((i) => i.datasetId)))))]
}

/** A story with ids swapped where a map knows them (a document opened under new ids). */
export function remapStory(s: Story, to: { dataset?: (id: string) => string | undefined; visualization?: (id: string) => string | undefined; transform?: (id: string) => string | undefined }): Story {
  const ds = (id: string) => to.dataset?.(id) ?? id
  const viz = (id: string) => to.visualization?.(id) ?? id
  const about = (a: Scene['about']): Scene['about'] =>
    !a ? a : { kind: a.kind, id: a.kind === 'dataset' ? ds(a.id) : a.kind === 'visualization' ? viz(a.id) : (to.transform?.(a.id) ?? a.id) }
  return {
    ...s,
    visualizationIds: s.visualizationIds.map(viz),
    scenes: s.scenes.map((sc) => ({
      ...sc,
      ...(sc.about ? { about: about(sc.about) } : {}),
      figures: sc.figures.map((f) => (f.kind === 'map' ? { ...f, viz: { ...f.viz, datasetId: ds(f.viz.datasetId) } } : { ...f, inputs: f.inputs.map((i) => ({ ...i, datasetId: ds(i.datasetId) })) })),
    })),
  }
}

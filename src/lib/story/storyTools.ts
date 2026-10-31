// The storyteller's tools: query the data (the assistant's query_sql), and
// write the story. write_story checks every scene and runs every figure (its
// SQL, or the map's settings against the dataset) before anything is saved, so
// a story never holds a figure that can't be drawn; the story lands in the
// workspace draft (Save keeps it). Asked again in the same chat, it rewrites the
// same story.

import type { ToolOutcome } from '../agent/loop'
import type { ToolSpec } from '../agent/provider'
import { Invalid, readVisualization, runTool, TOOLS, type AgentHost } from '../agent/tools'
import { newId } from '../dataset/dataset'
import { addStory, updateStory } from '../workspace/workspace'
import { CHART_KINDS, MAX_FIGURES, MAX_SCENES, NARRATIVE_WORDS, readStory, runFigure, type Figure, type Scene, type Story } from './story'

const s = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) })

const FIGURE = {
  type: 'object',
  description: 'Every property is required: give "" (or [] / false) for the ones this kind of figure doesn\'t use.',
  properties: {
    kind: { type: 'string', enum: ['sample', 'chart', 'map'] },
    caption: s('One short line under the figure.'),
    sql: s('sample / chart: one SELECT over the inputs (by alias). A sample shows its first 8 rows: pick the columns that matter, ORDER BY something telling. A chart: aggregate to what it draws.'),
    inputs: { type: 'array', items: { type: 'object', properties: { datasetId: s(), alias: s() }, required: ['datasetId', 'alias'] } },
    chart: { type: 'string', enum: ['', ...CHART_KINDS], description: 'chart: bar (≤ 30 rows: category x, number y), pie (≤ 12 rows: shares), line (x a number or year, y a number), scatter (two numbers), histogram (x only: how a number is spread).' },
    x: s('chart: the x column of the SQL result.'),
    y: s('chart: the y column (not for histogram).'),
    visualizationId: s('map: draw one of the workspace visualizations as it is (its id) — or leave "" and describe a map with the fields below.'),
    datasetId: s('map: the dataset to draw.'),
    geometry: s('map: its geometry column.'),
    label: s('map: a column naming each feature ("" for none).'),
    column: s('map: the value column to color by.'),
    aggregation: s('map: first, count, distinct, sum, mean, min, max, mode or any ("" for the default).'),
    colormap: s('map: viridis, magma, plasma, blues, greens, ylOrRd, rdBu … ("" for the default).'),
    reverse: { type: 'boolean', description: 'map: reverse the colormap.' },
    hide: { type: 'array', items: { type: 'string' }, description: 'map: names of features to leave off (e.g. far-off territories that would shrink the map).' },
    fit: { type: 'string', enum: ['main', 'all'], description: 'map: main fits the main group of features (far-off ones out of view, still drawn); all fits every feature.' },
  },
  required: ['kind', 'caption', 'sql', 'inputs', 'chart', 'x', 'y', 'visualizationId', 'datasetId', 'geometry', 'label', 'column', 'aggregation', 'colormap', 'reverse', 'hide', 'fit'],
}

export const STORY_TOOLS: ToolSpec[] = [
  TOOLS.find((t) => t.name === 'query_sql')!,
  {
    name: 'write_story',
    description: `Write the story (or rewrite it: in this chat, the same story is replaced). Scenes in order from the starting data to the maps, at most ${MAX_SCENES}; each a title, a narrative of about ${NARRATIVE_WORDS} words (plain text, **bold** sparingly) and at most ${MAX_FIGURES} figures. Every figure is run before saving; anything wrong comes back as a list to fix, and nothing is saved until all of it is right.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: s('The story\'s title.'),
        scenes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: s(),
              narrative: s(),
              about_kind: { type: 'string', enum: ['', 'dataset', 'transform', 'visualization'] },
              about_id: s('The id of the dataset, transform or visualization the scene is about ("" for none).'),
              figures: { type: 'array', items: FIGURE },
            },
            required: ['title', 'narrative', 'about_kind', 'about_id', 'figures'],
          },
        },
      },
      required: ['name', 'scenes'],
    },
  },
]

/** The chat's story: what it was asked to tell, and the story it wrote (rewritten in place). */
export interface StoryChat {
  visualizationIds: string[]
  storyId?: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const err = (message: string, summary = message): ToolOutcome => ({ content: message, isError: true, summary })

export async function runStoryTool(host: AgentHost, chat: StoryChat, name: string, input: unknown): Promise<ToolOutcome> {
  if (name === 'query_sql') return runTool(host, name, input)
  if (name !== 'write_story') return err(`No tool "${name}"`)
  return writeStory(host, chat, isObj(input) ? input : {})
}

async function writeStory(host: AgentHost, chat: StoryChat, input: Obj): Promise<ToolOutcome> {
  const doc = host.doc()
  if (!str(input.name) || !Array.isArray(input.scenes)) return err('write_story needs a name and scenes')
  // Figures read the workspace's datasets only, so the story works wherever the workspace opens.
  const inWorkspace = new Set([...doc.datasetIds, ...doc.transforms.flatMap((t) => t.outputs.flatMap((o) => (o.outputId ? [o.outputId] : [])))])
  const errors: string[] = []
  const scenes: Scene[] = []
  for (const [n, raw] of input.scenes.entries()) {
    const where = `scenes[${n}]`
    if (!isObj(raw)) {
      errors.push(`${where} must be an object`)
      continue
    }
    const figures: Figure[] = []
    for (const [m, f] of (Array.isArray(raw.figures) ? raw.figures : []).entries()) {
      const w = `${where}.figures[${m}]`
      if (!isObj(f)) continue
      const fig = await readFigureInput(host, f, w, inWorkspace, errors)
      if (fig) figures.push(fig)
    }
    const kind = raw.about_kind
    const about: Scene['about'] = (kind === 'dataset' || kind === 'transform' || kind === 'visualization') && str(raw.about_id) && raw.about_id ? { kind, id: raw.about_id } : undefined
    scenes.push({ id: `s${n + 1}`, title: str(raw.title) ? raw.title : '', narrative: str(raw.narrative) ? raw.narrative : '', ...(about ? { about } : {}), figures })
  }
  const story = readStory({ id: chat.storyId ?? newId(), name: input.name, visualizationIds: chat.visualizationIds, writtenAt: new Date().toISOString(), scenes }, errors)
  if (errors.length || !story) return err(`Nothing was saved. Fix these and write the story again:\n- ${errors.join('\n- ')}`, `refused: ${errors.length} problem${errors.length === 1 ? '' : 's'}`)
  const exists = (host.doc().stories ?? []).some((x) => x.id === story.id)
  const r = exists ? updateStory(host.doc(), story) : addStory(host.doc(), story)
  if (!r.ok) return err(r.error.message)
  host.setDoc(r.doc)
  chat.storyId = story.id
  const figs = story.scenes.reduce((k, sc) => k + sc.figures.length, 0)
  return {
    content: JSON.stringify({ saved: true, storyId: story.id, scenes: story.scenes.length, figures: figs, note: 'The story is in the workspace (a draft until the user saves). Tell the user in a line or two; they open it from Stories.' }),
    isError: false,
    summary: `${exists ? 'rewritten' : 'written'} · ${story.scenes.length} scenes · ${figs} figures`,
  }
}

async function readFigureInput(host: AgentHost, f: Obj, where: string, inWorkspace: Set<string>, errors: string[]): Promise<Figure | null> {
  const caption = str(f.caption) && f.caption.trim() ? { caption: f.caption.trim() } : {}
  if (f.kind === 'sample' || f.kind === 'chart') {
    const inputs = Array.isArray(f.inputs) ? f.inputs.filter(isObj).map((i) => ({ datasetId: String(i.datasetId ?? ''), alias: String(i.alias ?? '') })) : []
    const outside = inputs.find((i) => !inWorkspace.has(i.datasetId))
    if (outside) {
      errors.push(`${where}: dataset "${outside.datasetId}" isn't in the workspace (figures read the workspace's datasets only)`)
      return null
    }
    if (!str(f.sql) || !f.sql.trim()) {
      errors.push(`${where}: needs sql`)
      return null
    }
    const fig: Figure =
      f.kind === 'sample'
        ? { kind: 'sample', sql: f.sql.trim(), inputs, ...caption }
        : { kind: 'chart', chart: f.chart as 'bar', x: String(f.x ?? ''), ...(str(f.y) && f.y && f.chart !== 'histogram' ? { y: f.y } : {}), sql: f.sql.trim(), inputs, ...caption }
    if (fig.kind === 'chart' && !CHART_KINDS.includes(fig.chart)) {
      errors.push(`${where}.chart must be one of ${CHART_KINDS.join(', ')}`)
      return null
    }
    const snap = await runFigure(fig, (sql, ins, limit) => host.query(sql, ins, limit))
    if (typeof snap === 'string') {
      errors.push(`${where}: ${snap}`)
      return null
    }
    return { ...fig, snapshot: snap }
  }
  if (f.kind === 'map') {
    const extra = { ...(Array.isArray(f.hide) && f.hide.length ? { hide: f.hide.filter(str) } : {}), ...(f.fit === 'all' ? { fit: 'all' as const } : {}), ...caption }
    if (str(f.visualizationId) && f.visualizationId) {
      const v = host.doc().visualizations.find((x) => x.id === f.visualizationId)
      if (!v) {
        errors.push(`${where}: no visualization "${f.visualizationId}" in the workspace`)
        return null
      }
      const { id: _id, visible: _v, ...viz } = v
      return { kind: 'map', viz, ...extra }
    }
    if (!str(f.datasetId) || !inWorkspace.has(f.datasetId)) {
      errors.push(`${where}: a map needs a visualizationId, or a datasetId of the workspace`)
      return null
    }
    try {
      const v = await readVisualization(
        host,
        {
          name: (str(f.caption) && f.caption.trim()) || String(f.column ?? ''),
          datasetId: f.datasetId,
          binding: { kind: 'geometry', column: String(f.geometry ?? ''), ...(str(f.label) && f.label ? { label: f.label } : {}) },
          column: String(f.column ?? ''),
          ...(str(f.aggregation) && f.aggregation ? { aggregation: f.aggregation } : {}),
          ...(str(f.colormap) && f.colormap ? { style: { color: { kind: 'colormap', colormap: f.colormap, ...(f.reverse === true ? { reverse: true } : {}) } } } : {}),
        },
        where,
      )
      const { id: _id, visible: _v, ...viz } = v
      return { kind: 'map', viz, ...extra }
    } catch (e) {
      if (!(e instanceof Invalid)) throw e
      errors.push(e.message)
      return null
    }
  }
  errors.push(`${where}.kind must be sample, chart or map`)
  return null
}

/** The storyteller's first message: what to tell, and everything behind it. */
export function storyRequest(names: string[], lineage: string, rewrite?: Story): string {
  return [
    `Tell the story of ${names.length === 1 ? 'this visualization' : `these ${names.length} visualizations`}: ${names.map((n) => `"${n}"`).join(', ')}.`,
    ...(rewrite ? ['', `Rewrite the existing story "${rewrite.name}" (it is replaced). Its scenes were:`, ...rewrite.scenes.map((sc, i) => `${i + 1}. ${sc.title}`)] : []),
    '',
    lineage,
  ].join('\n')
}

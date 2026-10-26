// The workspace as a graph (DAG): datasets → transforms → output datasets →
// visualizations. Built from the workspace document plus the datasets'
// registry records; laid out automatically in rows (nothing is stored).
//
// Rows: a dataset no transform makes is row 0; a transform sits one row below
// its deepest input, its output one row below it; every visualization goes in
// the bottom row. Within a row nodes are ordered by the mean position of what
// feeds them (one barycenter pass), which keeps most arrows from crossing.

import type { WorkspaceDoc } from './workspace'

export type DagNodeKind = 'dataset' | 'transform' | 'viz'

export interface DagNode {
  /** `ds:<id>`, `tr:<id>` or `viz:<id>`. */
  key: string
  kind: DagNodeKind
  /** The dataset / transform / visualization id. */
  id: string
  label: string
  /** A short second line: row count, run state, the visualized column… */
  detail: string
  /** Transforms: never run, or an input changed since the last run. */
  state?: 'ready' | 'not-run' | 'stale'
  /** Visualizations: hidden on the map. */
  muted?: boolean
  row: number
  /** Position within the row, 0 = left. */
  order: number
}

export interface DagEdge {
  from: string
  to: string
}

export interface Dag {
  nodes: DagNode[]
  edges: DagEdge[]
  rows: number
}

/** What the graph needs to know about a dataset record. */
export interface DagDataset {
  name: string
  rowCount: number
  updatedAt: string
}

const dsKey = (id: string) => `ds:${id}`
const trKey = (id: string) => `tr:${id}`
const vizKey = (id: string) => `viz:${id}`

export function buildDag(doc: WorkspaceDoc, dataset: (id: string) => DagDataset | undefined): Dag {
  const nodes = new Map<string, DagNode>()
  const edges: DagEdge[] = []
  const madeBy = new Map<string, string>() // dataset id → transform id

  const addDataset = (id: string) => {
    if (nodes.has(dsKey(id))) return
    const d = dataset(id)
    nodes.set(dsKey(id), { key: dsKey(id), kind: 'dataset', id, label: d?.name ?? 'Missing dataset', detail: d ? `${d.rowCount.toLocaleString()} rows` : 'not in the database', row: 0, order: 0 })
  }
  for (const id of doc.datasetIds) addDataset(id)
  for (const t of doc.transforms) {
    for (const i of t.inputs) addDataset(i.datasetId)
    if (t.outputId) {
      addDataset(t.outputId)
      madeBy.set(t.outputId, t.id)
    }
  }
  for (const t of doc.transforms) {
    const out = t.outputId ? dataset(t.outputId) : undefined
    const newest = Math.max(...t.inputs.map((i) => Date.parse(dataset(i.datasetId)?.updatedAt ?? '') || 0))
    const state: DagNode['state'] = !out ? 'not-run' : newest > (Date.parse(out.updatedAt) || 0) ? 'stale' : 'ready'
    const detail = state === 'not-run' ? 'not run yet' : state === 'stale' ? 'needs re-run' : `${t.inputs.length} input${t.inputs.length === 1 ? '' : 's'}`
    nodes.set(trKey(t.id), { key: trKey(t.id), kind: 'transform', id: t.id, label: t.name, detail, state, row: 0, order: 0 })
    for (const i of t.inputs) edges.push({ from: dsKey(i.datasetId), to: trKey(t.id) })
    if (t.outputId) edges.push({ from: trKey(t.id), to: dsKey(t.outputId) })
  }

  // Rows by depth (a transform reading its own output can't loop forever).
  const depth = new Map<string, number>()
  const trById = new Map(doc.transforms.map((t) => [t.id, t]))
  function rowOf(key: string, seen = new Set<string>()): number {
    const known = depth.get(key)
    if (known !== undefined) return known
    if (seen.has(key)) return 0
    seen.add(key)
    const n = nodes.get(key)!
    let r = 0
    if (n.kind === 'transform') {
      const t = trById.get(n.id)!
      r = t.inputs.length ? Math.max(...t.inputs.map((i) => rowOf(dsKey(i.datasetId), seen))) + 1 : 0
    } else if (n.kind === 'dataset' && madeBy.has(n.id)) {
      r = rowOf(trKey(madeBy.get(n.id)!), seen) + 1
    }
    depth.set(key, r)
    return r
  }
  for (const n of nodes.values()) n.row = rowOf(n.key)

  const dataRows = nodes.size ? Math.max(...[...nodes.values()].map((n) => n.row)) + 1 : 0
  for (const v of doc.visualizations) {
    if (!nodes.has(dsKey(v.datasetId))) continue
    const what = v.column === '__rows' ? 'row count' : v.column.replace(/_/g, ' ')
    nodes.set(vizKey(v.id), { key: vizKey(v.id), kind: 'viz', id: v.id, label: v.name, detail: what, muted: !v.visible, row: dataRows, order: 0 })
    edges.push({ from: dsKey(v.datasetId), to: vizKey(v.id) })
  }

  // Order within rows: row 0 as the workspace lists datasets; below, by the
  // mean position of each node's parents (ties keep document order).
  const rows = dataRows + (doc.visualizations.length ? 1 : 0)
  const parents = new Map<string, string[]>()
  for (const e of edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from])
  const all = [...nodes.values()]
  for (let r = 0; r < rows; r++) {
    const inRow = all.filter((n) => n.row === r)
    const score = (n: DagNode, i: number) => {
      const ps = (parents.get(n.key) ?? []).map((p) => nodes.get(p)!).filter((p) => p.row < r)
      return ps.length ? ps.reduce((s, p) => s + p.order, 0) / ps.length : r === 0 ? i : Number.MAX_SAFE_INTEGER
    }
    inRow
      .map((n, i) => ({ n, s: score(n, i), i }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .forEach(({ n }, i) => (n.order = i))
  }
  return { nodes: all, edges, rows }
}

// ── layout ─────────────────────────────────────────────────────────────────

export interface DagLayout {
  width: number
  height: number
  /** Node key → top-left corner. */
  at: Map<string, { x: number; y: number }>
}

export const NODE_W = 96
export const NODE_H = 76
const GAP_X = 12
const GAP_Y = 44
const PAD = 8

/** Pixel positions: rows top to bottom, each row centered in the widest one (or `minWidth`). */
export function layoutDag(dag: Dag, minWidth = 0): DagLayout {
  const counts = Array.from({ length: dag.rows }, (_, r) => dag.nodes.filter((n) => n.row === r).length)
  const rowWidth = (n: number) => n * NODE_W + Math.max(0, n - 1) * GAP_X
  const width = Math.max(minWidth, ...counts.map(rowWidth).map((w) => w + PAD * 2))
  const at = new Map<string, { x: number; y: number }>()
  for (const n of dag.nodes) {
    const left = (width - rowWidth(counts[n.row])) / 2
    at.set(n.key, { x: Math.round(left + n.order * (NODE_W + GAP_X)), y: PAD + n.row * (NODE_H + GAP_Y) })
  }
  return { width, height: dag.rows ? PAD * 2 + dag.rows * NODE_H + (dag.rows - 1) * GAP_Y : 0, at }
}

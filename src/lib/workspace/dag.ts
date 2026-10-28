// The workspace as a graph (DAG): datasets → transforms → output datasets →
// visualizations. Built from the workspace document plus the datasets'
// registry records; laid out automatically in rows (nothing is stored).
//
// Rows: a dataset no transform makes is row 0; a transform sits one row below
// its deepest input, its output one row below it; every visualization goes in
// the bottom row. Within a row nodes are ordered to keep arrows from crossing
// (orderLayers); positions come from layoutDag, top to bottom or left to right.

import type { TransformSpec, WorkspaceDoc } from './workspace'

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
  /** Can't work on this device: a missing dataset, or something waiting on one (lib/workspace/unavailable.ts). */
  problem?: 'missing' | 'waits'
  /** Datasets: where they're kept (cloud or this device). */
  store?: 'local' | 'remote'
  /** Datasets: a transform's output that's out of date (its transform needs a re-run) or not made yet. */
  pending?: boolean
  row: number
  /** Position within the row, 0 = left. */
  order: number
}

export interface DagEdge {
  from: string
  to: string
  /** Virtual points (one per row it skips) the arrow passes through; set by buildDag. */
  via?: string[]
}

export interface Dag {
  nodes: DagNode[]
  edges: DagEdge[]
  rows: number
  /** Each row's keys in order, virtual points (`v:…`) included. */
  layers: string[][]
}

/** What the graph needs to know about a dataset record. */
export interface DagDataset {
  name: string
  rowCount: number
  updatedAt: string
  /** Linked to a cloud dataset (shown as a violet dot). */
  link?: unknown
}

const dsKey = (id: string) => `ds:${id}`
const trKey = (id: string) => `tr:${id}`
const vizKey = (id: string) => `viz:${id}`

/** Not run: an output has never been written. Stale: an input changed after the oldest output. */
export function transformState(t: TransformSpec, dataset: (id: string) => DagDataset | undefined): 'ready' | 'not-run' | 'stale' {
  const outs = t.outputs.map((o) => (o.outputId ? dataset(o.outputId) : undefined))
  if (!outs.length || outs.some((d) => !d)) return 'not-run'
  const newest = Math.max(0, ...t.inputs.map((i) => Date.parse(dataset(i.datasetId)?.updatedAt ?? '') || 0))
  const oldest = Math.min(...outs.map((d) => Date.parse(d?.updatedAt ?? '') || 0))
  return newest > oldest ? 'stale' : 'ready'
}

/**
 * What "Run all stale" runs, in order: every transform that needs a re-run —
 * stale, or set to write a dataset this device doesn't have (an output of a
 * workspace opened elsewhere) while its inputs are here — plus every
 * transform downstream of one (it will be stale once its inputs are
 * rewritten), each after the transforms that write its inputs. Transforms
 * never run (no output dataset yet) are left out — they may be unfinished drafts.
 */
export function staleRunOrder(doc: WorkspaceDoc, dataset: (id: string) => DagDataset | undefined): string[] {
  const writer = new Map<string, string>() // dataset id → transform id
  for (const t of doc.transforms) for (const o of t.outputs) if (o.outputId) writer.set(o.outputId, t.id)
  const byId = new Map(doc.transforms.map((t) => [t.id, t]))
  const upstream = (t: TransformSpec) => [...new Set(t.inputs.flatMap((i) => writer.get(i.datasetId) ?? []))].filter((u) => u !== t.id)

  // Pending: stale ones, then anything (already run) reading a pending one's output, to a fixed point.
  const outputMissing = (t: TransformSpec) => t.outputs.some((o) => o.outputId && !dataset(o.outputId))
  const inputsHere = (t: TransformSpec) => t.inputs.every((i) => dataset(i.datasetId))
  const pending = new Set(doc.transforms.filter((t) => transformState(t, dataset) === 'stale' || (outputMissing(t) && inputsHere(t))).map((t) => t.id))
  for (let grew = true; grew; ) {
    grew = false
    for (const t of doc.transforms) {
      if (pending.has(t.id) || !t.outputs.some((o) => o.outputId)) continue
      if (upstream(t).some((u) => pending.has(u))) {
        pending.add(t.id)
        grew = true
      }
    }
  }
  // Inputs first (depth-first; a cycle can't recurse forever).
  const order: string[] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id) || !pending.has(id)) return
    seen.add(id)
    for (const u of upstream(byId.get(id)!)) visit(u)
    order.push(id)
  }
  for (const t of doc.transforms) visit(t.id)
  return order
}

export function buildDag(doc: WorkspaceDoc, dataset: (id: string) => DagDataset | undefined): Dag {
  const nodes = new Map<string, DagNode>()
  const edges: DagEdge[] = []
  const madeBy = new Map<string, string>() // dataset id → transform id

  const addDataset = (id: string) => {
    if (nodes.has(dsKey(id))) return
    const d = dataset(id)
    nodes.set(dsKey(id), { key: dsKey(id), kind: 'dataset', id, label: d?.name ?? 'Missing dataset', detail: d ? `${d.rowCount.toLocaleString()} rows` : 'not in the database', store: d?.link ? 'remote' : 'local', row: 0, order: 0 })
  }
  for (const id of doc.datasetIds) addDataset(id)
  for (const t of doc.transforms) {
    for (const i of t.inputs) addDataset(i.datasetId)
    for (const o of t.outputs) {
      if (!o.outputId) continue
      addDataset(o.outputId)
      madeBy.set(o.outputId, t.id)
    }
  }
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  for (const t of doc.transforms) {
    const state = transformState(t, dataset)
    const detail = state === 'not-run' ? 'not run yet' : state === 'stale' ? 'needs re-run' : `${plural(t.inputs.length, 'input')} → ${plural(t.outputs.length, 'output')}`
    nodes.set(trKey(t.id), { key: trKey(t.id), kind: 'transform', id: t.id, label: t.name, detail, state, row: 0, order: 0 })
    for (const i of t.inputs) edges.push({ from: dsKey(i.datasetId), to: trKey(t.id) })
    for (const o of t.outputs) if (o.outputId) edges.push({ from: trKey(t.id), to: dsKey(o.outputId) })
    // Its outputs are out of date while it needs a run (or not made yet, when not here).
    for (const o of t.outputs) {
      const n = o.outputId ? nodes.get(dsKey(o.outputId)) : undefined
      if (n && (state !== 'ready' || !dataset(n.id))) n.pending = true
    }
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

  // Order within rows: fewest arrow crossings (see orderLayers). Row 0 starts in the workspace's order.
  const rows = dataRows + (doc.visualizations.length ? 1 : 0)
  const all = [...nodes.values()]
  const layers = orderLayers(all, edges, rows)
  layers.forEach((layer) => layer.forEach((key, i) => nodes.get(key) && (nodes.get(key)!.order = i)))
  return { nodes: all, edges, rows, layers }
}

// ── ordering: fewer crossings ──────────────────────────────────────────────
//
// The layered ("Sugiyama") recipe: an arrow that skips rows gets a virtual
// point in every row it passes, so it takes a slot there (and is drawn
// through it) instead of cutting across nodes. Then rows are re-ordered by
// the mean position of their neighbours above, then below, a few times over,
// with a pass that swaps neighbours when that removes crossings; the order
// with the fewest crossings wins.

/** A virtual point's key: edge index + row. */
export const isVirtual = (key: string) => key.startsWith('v:')

function orderLayers(nodes: DagNode[], edges: DagEdge[], rows: number): string[][] {
  const layers: string[][] = Array.from({ length: rows }, () => [])
  for (const n of nodes) layers[n.row]?.push(n.key) // insertion order: row 0 = workspace order
  const rowOf = new Map(nodes.map((n) => [n.key, n.row]))
  const up = new Map<string, string[]>()
  const down = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    down.set(a, [...(down.get(a) ?? []), b])
    up.set(b, [...(up.get(b) ?? []), a])
  }
  edges.forEach((e, i) => {
    const a = rowOf.get(e.from)
    const b = rowOf.get(e.to)
    e.via = []
    if (a === undefined || b === undefined || b <= a) return // a loop back (a transform reading its own output): drawn, not ordered
    let prev = e.from
    for (let r = a + 1; r < b; r++) {
      const v = `v:${i}:${r}`
      layers[r].push(v)
      e.via.push(v)
      link(prev, v)
      prev = v
    }
    link(prev, e.to)
  })

  const pos = () => new Map(layers.flatMap((l) => l.map((k, i) => [k, i] as const)))
  /** Crossings between row r and r + 1: pairs of links whose ends are in opposite orders. */
  const crossingsAt = (r: number, at: Map<string, number>) => {
    const links = layers[r].flatMap((a) => (down.get(a) ?? []).map((b) => [at.get(a)!, at.get(b)!] as const))
    let c = 0
    for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) if ((links[i][0] - links[j][0]) * (links[i][1] - links[j][1]) < 0) c++
    return c
  }
  const crossings = () => {
    const at = pos()
    let c = 0
    for (let r = 0; r + 1 < rows; r++) c += crossingsAt(r, at)
    return c
  }
  /** Re-orders a row by the mean position of its neighbours in the next row (nodes with none stay put). */
  const sortBy = (r: number, neighbours: Map<string, string[]>) => {
    const at = pos()
    const score = (k: string, i: number) => {
      const ns = neighbours.get(k) ?? []
      return ns.length ? ns.reduce((s, n) => s + at.get(n)!, 0) / ns.length : i
    }
    layers[r] = layers[r]
      .map((k, i) => ({ k, s: score(k, i), i }))
      .sort((x, y) => x.s - y.s || x.i - y.i)
      .map((x) => x.k)
  }
  /** Swaps neighbours in a row while that lowers the crossings around it. */
  const transpose = () => {
    for (let r = 0; r < rows; r++) {
      let better = true
      while (better) {
        better = false
        for (let i = 0; i + 1 < layers[r].length; i++) {
          const local = () => {
            const at = pos()
            return (r > 0 ? crossingsAt(r - 1, at) : 0) + (r + 1 < rows ? crossingsAt(r, at) : 0)
          }
          const before = local()
          ;[layers[r][i], layers[r][i + 1]] = [layers[r][i + 1], layers[r][i]]
          if (local() < before) better = true
          else [layers[r][i], layers[r][i + 1]] = [layers[r][i + 1], layers[r][i]]
        }
      }
    }
  }

  let best = layers.map((l) => [...l])
  let bestC = crossings()
  for (let pass = 0; pass < 12 && bestC > 0; pass++) {
    if (pass % 2 === 0) for (let r = 1; r < rows; r++) sortBy(r, up)
    else for (let r = rows - 2; r >= 0; r--) sortBy(r, down)
    transpose()
    const c = crossings()
    if (c < bestC) {
      best = layers.map((l) => [...l])
      bestC = c
    }
  }
  return best
}

// ── layout ─────────────────────────────────────────────────────────────────

/** Top to bottom (rows are rows) or left to right (rows are columns). */
export type DagDirection = 'vertical' | 'horizontal'

export interface DagLayout {
  width: number
  height: number
  direction: DagDirection
  /** Node key → top-left corner. */
  at: Map<string, { x: number; y: number }>
  /** Virtual point key → the point an arrow passes through. */
  points: Map<string, { x: number; y: number }>
}

export const NODE_W = 96
export const NODE_H = 76
/** Room a passing arrow takes in a row. */
const LANE = 20
const GAP_CROSS = 12
const GAP_ALONG = { vertical: 44, horizontal: 56 }
const PAD = 8

/** Pixel positions: each row (column, left to right) centered on the widest. */
export function layoutDag(dag: Dag, direction: DagDirection = 'vertical'): DagLayout {
  const v = direction === 'vertical'
  const along = v ? NODE_H : NODE_W // a row's depth
  const cross = (key: string) => (isVirtual(key) ? LANE : v ? NODE_W : NODE_H)
  const span = (layer: string[]) => layer.reduce((s, k) => s + cross(k), 0) + Math.max(0, layer.length - 1) * GAP_CROSS
  const widest = Math.max(0, ...dag.layers.map(span))
  const at = new Map<string, { x: number; y: number }>()
  const points = new Map<string, { x: number; y: number }>()
  dag.layers.forEach((layer, r) => {
    let c = PAD + (widest - span(layer)) / 2
    const a = PAD + r * (along + GAP_ALONG[direction])
    for (const key of layer) {
      const size = cross(key)
      if (isVirtual(key)) points.set(key, v ? { x: Math.round(c + size / 2), y: a + along / 2 } : { x: a + along / 2, y: Math.round(c + size / 2) })
      else at.set(key, v ? { x: Math.round(c), y: a } : { x: a, y: Math.round(c) })
      c += size + GAP_CROSS
    }
  })
  const depth = dag.rows ? PAD * 2 + dag.rows * along + (dag.rows - 1) * GAP_ALONG[direction] : 0
  const breadth = widest + PAD * 2
  return { width: v ? breadth : depth, height: v ? depth : breadth, direction, at, points }
}

/**
 * An arrow's SVG path: out of the parent's far side (bottom, or right), through
 * its virtual points, into the child's near side (top, or left) — smooth
 * curves that leave and enter along the flow. `gap` leaves room for the head.
 */
export function edgePath(layout: DagLayout, e: DagEdge, gap = 3): string | null {
  const a = layout.at.get(e.from)
  const b = layout.at.get(e.to)
  if (!a || !b) return null
  const v = layout.direction === 'vertical'
  const start = v ? { x: a.x + NODE_W / 2, y: a.y + NODE_H } : { x: a.x + NODE_W, y: a.y + NODE_H / 2 }
  const end = v ? { x: b.x + NODE_W / 2, y: b.y - gap } : { x: b.x - gap, y: b.y + NODE_H / 2 }
  const pts = [start, ...(e.via ?? []).flatMap((k) => layout.points.get(k) ?? []), end]
  let d = `M ${start.x} ${start.y}`
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]
    const q = pts[i]
    if (v) {
      const m = (p.y + q.y) / 2
      d += ` C ${p.x} ${m}, ${q.x} ${m}, ${q.x} ${q.y}`
    } else {
      const m = (p.x + q.x) / 2
      d += ` C ${m} ${p.y}, ${m} ${q.y}, ${q.x} ${q.y}`
    }
  }
  return d
}

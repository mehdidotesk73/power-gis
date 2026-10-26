import { describe, expect, it } from 'vitest'
import { buildDag, edgePath, layoutDag, NODE_H, NODE_W, type DagDataset } from './dag'
import { defaultScalarStyle, ROWS, type VisualizationSpec } from '../dataset/visualization'
import type { WorkspaceDoc } from './workspace'

const viz = (id: string, datasetId: string, visible = true): VisualizationSpec => ({
  kind: 'scalar',
  id,
  name: `viz ${id}`,
  datasetId,
  binding: { kind: 'geometry', column: 'geometry' },
  column: ROWS,
  aggregation: 'count',
  visible,
  style: defaultScalarStyle('int', 'region'),
})

// The default workspace's shape: three inputs → one transform → its output → visualizations; states → borders.
const doc: WorkspaceDoc = {
  name: 'w',
  datasetIds: ['out', 'utilities', 'links', 'counties', 'states'],
  visualizations: [viz('borders', 'states', false), viz('count', 'out')],
  transforms: [
    {
      id: 't',
      name: 'Utilities by county',

      inputs: [
        { datasetId: 'counties', alias: 'counties' },
        { datasetId: 'links', alias: 'links' },
        { datasetId: 'utilities', alias: 'utilities' },
      ],
      outputs: [{ key: 'o1', name: 'Utilities by county', sql: 'SELECT …', outputId: 'out' }],
    },
  ],
}
const at = (iso: string): DagDataset => ({ name: 'd', rowCount: 10, updatedAt: iso })
const records: Record<string, DagDataset> = {
  out: { ...at('2026-10-02T00:00:00Z'), name: 'Utilities by county' },
  utilities: at('2026-10-01T00:00:00Z'),
  links: at('2026-10-01T00:00:00Z'),
  counties: at('2026-10-01T00:00:00Z'),
  states: at('2026-10-01T00:00:00Z'),
}

describe('workspace DAG', () => {
  it('puts datasets, transforms, outputs and visualizations in rows', () => {
    const dag = buildDag(doc, (id) => records[id])
    const row = (key: string) => dag.nodes.find((n) => n.key === key)!.row
    expect([row('ds:counties'), row('tr:t'), row('ds:out'), row('viz:count'), row('viz:borders')]).toEqual([0, 1, 2, 3, 3])
    expect(row('ds:states')).toBe(0)
    expect(dag.rows).toBe(4)
    expect(dag.edges).toContainEqual(expect.objectContaining({ from: 'ds:links', to: 'tr:t' }))
    expect(dag.edges).toContainEqual(expect.objectContaining({ from: 'tr:t', to: 'ds:out' }))
    expect(dag.edges).toContainEqual(expect.objectContaining({ from: 'ds:states', to: 'viz:borders' }))
    expect(dag.nodes.find((n) => n.key === 'tr:t')!.state).toBe('ready')
    expect(dag.nodes.find((n) => n.key === 'viz:borders')!.muted).toBe(true)
  })

  it('orders each row under what feeds it, so arrows mostly run straight down', () => {
    const dag = buildDag(doc, (id) => records[id])
    const order = (key: string) => dag.nodes.find((n) => n.key === key)!.order
    // Row 0 keeps the workspace's order (out isn't in it: it's made by the transform).
    expect(['utilities', 'links', 'counties', 'states'].map((d) => order(`ds:${d}`))).toEqual([0, 1, 2, 3])
    // The output's visualization sits left of the states' one (its parent is further left).
    expect(order('viz:count')).toBeLessThan(order('viz:borders'))
  })

  it('marks transforms never run, and ones whose inputs changed since', () => {
    const fresh = { ...doc, transforms: [{ ...doc.transforms[0], outputs: [{ ...doc.transforms[0].outputs[0], outputId: undefined }] }] }
    expect(buildDag(fresh, (id) => records[id]).nodes.find((n) => n.key === 'tr:t')).toMatchObject({ state: 'not-run', detail: 'not run yet' })
    const changed: Record<string, DagDataset> = { ...records, links: at('2026-10-03T00:00:00Z') }
    expect(buildDag(doc, (id) => changed[id]).nodes.find((n) => n.key === 'tr:t')).toMatchObject({ state: 'stale', detail: 'needs re-run' })
  })

  it('survives a transform that reads its own output', () => {
    const loop = { ...doc, transforms: [{ ...doc.transforms[0], inputs: [{ datasetId: 'out', alias: 'out' }] }] }
    expect(() => buildDag(loop, (id) => records[id])).not.toThrow()
  })

  it('lays rows out centered, widest row setting the width', () => {
    const dag = buildDag(doc, (id) => records[id])
    const l = layoutDag(dag)
    expect(l.width).toBeGreaterThanOrEqual(4 * NODE_W) // four datasets in row 0
    const ys = [...new Set([...l.at.values()].map((p) => p.y))]
    expect(ys).toHaveLength(4)
  })

  it('lays rows out as columns when horizontal', () => {
    const dag = buildDag(doc, (id) => records[id])
    const v = layoutDag(dag, 'vertical')
    const h = layoutDag(dag, 'horizontal')
    expect(h.height).toBeGreaterThanOrEqual(4 * NODE_H)
    expect(new Set([...h.at.values()].map((p) => p.x)).size).toBe(4) // one x per row
    expect(h.at.get('tr:t')!.x).toBeGreaterThan(h.at.get('ds:counties')!.x)
    expect(v.at.get('tr:t')!.y).toBeGreaterThan(v.at.get('ds:counties')!.y)
    expect(edgePath(h, { from: 'ds:links', to: 'tr:t' })).toMatch(/^M /)
  })

  it('routes arrows that skip rows through points of their own, and avoids crossings', () => {
    // a → t → o; a and b also feed v directly (skipping rows), c feeds t.
    const d: WorkspaceDoc = {
      name: 'x',
      datasetIds: ['b', 'a', 'c', 'o'],
      visualizations: [viz('vb', 'b'), viz('va', 'a'), viz('vo', 'o')],
      transforms: [{ id: 't', name: 't', inputs: [{ datasetId: 'c', alias: 'c' }, { datasetId: 'a', alias: 'a' }], outputs: [{ key: 'k', name: 'o', sql: '', outputId: 'o' }] }],
    }
    const recs = (id: string): DagDataset => ({ name: id, rowCount: 1, updatedAt: '2026-01-01T00:00:00Z' })
    const dag = buildDag(d, recs)
    const skip = dag.edges.find((e) => e.from === 'ds:a' && e.to === 'viz:va')!
    expect(skip.via).toHaveLength(2) // passes rows 1 and 2
    const pos = new Map(dag.layers.flatMap((l) => l.map((k, i) => [k, i] as const)))
    const down = new Map<string, string[]>()
    for (const e of dag.edges) {
      const chain = [e.from, ...(e.via ?? []), e.to]
      for (let i = 0; i + 1 < chain.length; i++) down.set(chain[i], [...(down.get(chain[i]) ?? []), chain[i + 1]])
    }
    let crossings = 0
    for (const layer of dag.layers) {
      const links = layer.flatMap((a) => (down.get(a) ?? []).map((b) => [pos.get(a)!, pos.get(b)!]))
      for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) if ((links[i][0] - links[j][0]) * (links[i][1] - links[j][1]) < 0) crossings++
    }
    expect(crossings).toBe(0)
    const l = layoutDag(dag)
    expect(edgePath(l, skip)!.split(' C ')).toHaveLength(4) // three curves: through two points
  })
})

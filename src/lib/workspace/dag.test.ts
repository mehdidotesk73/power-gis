import { describe, expect, it } from 'vitest'
import { buildDag, layoutDag, NODE_W, type DagDataset } from './dag'
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
    expect(dag.edges).toContainEqual({ from: 'ds:links', to: 'tr:t' })
    expect(dag.edges).toContainEqual({ from: 'tr:t', to: 'ds:out' })
    expect(dag.edges).toContainEqual({ from: 'ds:states', to: 'viz:borders' })
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
    const l = layoutDag(dag, 300)
    expect(l.width).toBeGreaterThanOrEqual(4 * NODE_W) // four datasets in row 0
    const ys = [...new Set([...l.at.values()].map((p) => p.y))]
    expect(ys).toHaveLength(4)
    const out = l.at.get('ds:out')!
    expect(Math.round(out.x + NODE_W / 2)).toBe(Math.round(l.width / 2)) // alone in its row: centered
  })
})

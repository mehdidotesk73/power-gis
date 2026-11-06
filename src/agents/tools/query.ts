// Read the data: SQL queries, and the values a visualization draws.
// Each tool: its spec (what the model sees) next to its handler (what runs).

import { type TransformInputRef } from '../../shared/records'
import type { VizValues } from '../../lib/dataset/query'
import type { ToolOutcome } from '../../lib/agent/loop'
import { agentColor } from '../../lib/agent/workspaceFiles'
import type { ToolSpec } from '../../lib/agent/provider'
import { Obj, cell, columnsOf, err, isObj, need, ok, plural, str } from './common'
import { AgentHost, QUERY_LIMIT } from './host'

export const QUERY_TOOLS: ToolSpec[] = [
  {
    name: 'query_sql',
    strict: true,
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
    name: 'visualization_stats',
    description:
      'How the values a visualization draws are distributed: one value per feature, after the aggregation (which can differ from the raw rows). Numbers: count, nulls, min, percentiles, max, mean, how many are ≤ 0 and < 0, and how many orders of magnitude the positive values span. Text: distinct values and the most common. Use it after adding or changing a visualization to choose the scale (linear / log), colormap (sequential / diverging) and domain.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
]

export function readInputs(v: unknown): TransformInputRef[] {
  need(Array.isArray(v), '`inputs` must be a list of {datasetId, alias}')
  return v.map((i, n) => {
    need(isObj(i) && str(i.datasetId) && str(i.alias), `inputs[${n}] needs datasetId and alias`)
    return { datasetId: i.datasetId, alias: i.alias }
  })
}

export async function querySql(host: AgentHost, input: Obj): Promise<ToolOutcome> {
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

export const round = (n: number) => (Number.isInteger(n) ? n : Number(n.toPrecision(4)))

export function quantile(sorted: number[], q: number): number {
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

export async function visualizationStats(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  const v = host.doc().visualizations.find((x) => x.id === input.id)
  need(v, `No visualization "${input.id}" in the workspace (get_workspace lists them)`)
  const values = await host.values(v.datasetId, v.binding, v.column, v.aggregation)
  if (typeof values === 'string') return err(values)
  const stats = valueStats(values)
  return ok({ visualization: v.name, column: v.column, aggregation: v.aggregation, color: agentColor(v.style.color), ...stats }, `${plural(stats.withValue as number, 'feature')} with a value`)
}

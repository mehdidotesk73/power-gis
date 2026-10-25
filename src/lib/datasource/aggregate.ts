// Several rows can land on one feature (many utilities per county). Each
// visualized column is reduced to one value per feature by an aggregation.

import { isNumericColumn, type ColumnType } from './columns'
import { isVector, type Vector } from '../schema'

export const AGGREGATIONS = {
  first: 'First value',
  count: 'Count of values',
  distinct: 'Distinct values',
  sum: 'Sum',
  mean: 'Average',
  min: 'Minimum',
  max: 'Maximum',
  mode: 'Most common',
  any: 'Any true',
} as const
export type Aggregation = keyof typeof AGGREGATIONS

/** Aggregations that make sense for a column type. */
export function aggregationsFor(type: ColumnType): Aggregation[] {
  if (type === 'vector') return ['mean', 'sum', 'first', 'count']
  if (isNumericColumn(type)) return ['sum', 'mean', 'min', 'max', 'first', 'count', 'distinct', 'mode']
  if (type === 'boolean') return ['any', 'count', 'mode', 'first']
  if (type === 'datetime') return ['max', 'min', 'first', 'count', 'distinct']
  return ['mode', 'first', 'count', 'distinct']
}

/** Sensible default: pass-through when each feature has one row, otherwise summarize. */
export function defaultAggregation(type: ColumnType, rowsPerFeature: number): Aggregation {
  if (rowsPerFeature <= 1) return 'first'
  if (isNumericColumn(type)) return 'sum'
  if (type === 'vector') return 'mean'
  if (type === 'boolean') return 'any'
  if (type === 'datetime') return 'max'
  return 'mode'
}

/** Result type of an aggregation over a column. */
export function aggregatedType(agg: Aggregation, type: ColumnType): ColumnType {
  if (agg === 'count' || agg === 'distinct') return 'int'
  if (type === 'vector') return 'vector' // mean / sum / first of vectors is a vector
  if (agg === 'mean') return 'double'
  if (agg === 'any') return 'boolean'
  return type
}

/** Reduce already-coerced values (nulls allowed) to one. */
export function aggregate(values: unknown[], agg: Aggregation): unknown {
  const present = values.filter((v) => v !== null && v !== undefined)
  switch (agg) {
    case 'first':
      return present[0] ?? null
    case 'count':
      return present.length
    case 'distinct':
      return new Set(present.map((v) => (typeof v === 'object' ? JSON.stringify(v) : v))).size
    case 'any':
      return present.length ? present.some(Boolean) : null
    case 'mode': {
      if (!present.length) return null
      const counts = new Map<unknown, number>()
      for (const v of present) counts.set(v, (counts.get(v) ?? 0) + 1)
      let best: unknown = null
      let bestN = 0
      for (const [v, n] of counts) if (n > bestN || (n === bestN && String(v) < String(best))) (best = v), (bestN = n)
      return best
    }
  }
  const vecs = present.filter(isVector)
  if (vecs.length && (agg === 'sum' || agg === 'mean')) {
    // Component-wise: the mean of flows is the mean u and the mean v.
    const s: Vector = vecs.reduce((a, b) => ({ u: a.u + b.u, v: a.v + b.v }), { u: 0, v: 0 })
    return agg === 'sum' ? s : { u: s.u / vecs.length, v: s.v / vecs.length }
  }
  const nums = present.filter((v): v is number => typeof v === 'number')
  const strs = present.filter((v): v is string => typeof v === 'string')
  if (agg === 'min' || agg === 'max') {
    if (nums.length) return agg === 'min' ? Math.min(...nums) : Math.max(...nums)
    if (strs.length) return [...strs].sort()[agg === 'min' ? 0 : strs.length - 1] // ISO dates sort as text
    return null
  }
  if (!nums.length) return null
  const sum = nums.reduce((a, b) => a + b, 0)
  return agg === 'sum' ? sum : sum / nums.length
}

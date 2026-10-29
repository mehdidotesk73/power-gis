import { describe, expect, it } from 'vitest'
import { outputCheck } from './checks'
import type { DatasetRecord } from '../../shared/records'
import type { ColumnType } from '../dataset/columns'

const t0 = '2026-10-29T00:00:00Z'
function rec(id: string, rowCount: number, cols: [string, ColumnType, number, number, (number | string)?, (number | string)?][]): DatasetRecord {
  return {
    id,
    name: id,
    table: `ds_${id}`,
    columns: cols.map(([name, type]) => ({ name, type })),
    rowCount,
    origin: 'test',
    description: '',
    createdAt: t0,
    updatedAt: t0,
    profile: { rowCount, completeness: 1, columns: cols.map(([name, type, filled, distinct, min, max]) => ({ name, type, filled, distinct, ...(min !== undefined ? { min, max } : {}) })) },
  } as DatasetRecord
}

describe('the check run_transform returns for each output', () => {
  it('lists rows against the inputs, the unique columns, nulls and ranges', () => {
    const income = rec('inc', 3222, [['GEOID', 'string', 3222, 3222]])
    const out = rec('clean', 3222, [
      ['fips', 'string', 3222, 3222],
      ['median_hh_income', 'int', 3220, 3100, 20188, 174148],
      ['share', 'double', 3222, 3000, 0.123456789, 0.9],
      ['geometry', 'region', 3222, 3222],
    ])
    const c = outputCheck(out, [{ alias: 'inc', record: income }])
    expect(c.rows).toBe(3222)
    expect(c.inputs).toEqual([{ alias: 'inc', rows: 3222 }])
    expect(c.unique).toEqual(['fips']) // geometry aside
    expect(c.columns).toEqual([
      { name: 'fips', type: 'string', nulls: 0, distinct: 3222 },
      { name: 'median_hh_income', type: 'int', nulls: 2, distinct: 3100, min: 20188, max: 174148 },
      { name: 'share', type: 'double', nulls: 0, distinct: 3000, min: 0.123457, max: 0.9 },
      { name: 'geometry', type: 'region', nulls: 0 },
    ])
    expect(c.flags).toEqual([])
  })

  it('flags a join that multiplied rows, no key, an empty column, no rows', () => {
    const a = rec('a', 10, [['k', 'string', 10, 10]])
    const b = rec('b', 12, [['k', 'string', 12, 12]])
    const joined = rec('j', 15, [['k', 'string', 15, 10], ['v', 'double', 0, 0]])
    expect(outputCheck(joined, [{ alias: 'a', record: a }, { alias: 'b', record: b }]).flags).toEqual([
      '"v" is empty on every row',
      '15 rows, more than any input (12): did a join match more than one row per key?',
      'no column has a different value on every row: if a row should be one key, some keys repeat',
    ])
    expect(outputCheck(rec('e', 0, [['k', 'string', 0, 0]]), []).flags).toEqual(['no rows'])
  })
})

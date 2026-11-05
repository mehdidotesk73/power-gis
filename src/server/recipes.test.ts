// The reconciliation and Fermi recipes (lib/dataset/recipes.ts) run in real DuckDB, end to end: a Fermi
// estimate per region feeds a top-down spread as its coarse total, and a bottom-up fit scores the finer units
// against a coarse truth, including a region that has none.
import { describe, expect, it } from 'vitest'
import { createSqlRunner, type SqlInput } from './sql'
import { nodeDuckDb } from './testEngine'
import { recipeSql } from '../lib/dataset/recipes'
import type { ColumnInfo } from '../lib/dataset/columns'

const table = (alias: string, columns: ColumnInfo[], rows: Record<string, unknown>[]): SqlInput => ({ alias, version: 'v1', columns, rows: async () => rows })

const regions = table(
  'regions',
  [
    { name: 'region', type: 'string' },
    { name: 'households', type: 'int' },
    { name: 'gdp', type: 'double' },
  ],
  [
    { region: 'A', households: 1000, gdp: 100 },
    { region: 'B', households: 2000, gdp: 300 },
    { region: 'C', households: 500, gdp: null },
    { region: 'D', households: 1500, gdp: 160 },
  ],
)
const towns = table(
  'towns',
  [
    { name: 'town', type: 'string' },
    { name: 'region', type: 'string' },
    { name: 'pop', type: 'int' },
    { name: 'lights', type: 'double' },
  ],
  [
    { town: 'a1', region: 'A', pop: 1, lights: 10 },
    { town: 'a2', region: 'A', pop: 3, lights: 30 },
    { town: 'b1', region: 'B', pop: 2, lights: 50 },
    { town: 'b2', region: 'B', pop: 2, lights: 70 },
    { town: 'c1', region: 'C', pop: 5, lights: 20 },
    { town: 'd1', region: 'D', pop: 1, lights: 60 },
  ],
)

describe('reconciliation and Fermi recipes (DuckDB)', () => {
  const sql = createSqlRunner(nodeDuckDb)
  const byKey = (rows: Record<string, unknown>[], k: string) => Object.fromEntries(rows.map((r) => [r[k] as string, r]))

  it('a Fermi estimate per region, its total spread top-down over the towns, and a bottom-up fit of the towns to a coarse truth', async () => {
    // 1. Fermi: households × share that heat with oil (0.1 / 0.2 / 0.3) × litres a year (800 / 1000 / 1500).
    const fermi = recipeSql({ kind: 'fermi', base: 'regions', unit: 'region', quantity: 'households', factors: [{ name: 'share on oil', low: 0.1, likely: 0.2, high: 0.3 }, { name: 'litres a year', low: 800, likely: 1000, high: 1500 }] })
    const f = await sql.run(fermi.sql, [regions])
    expect(f.columns.map((c) => c.name)).toEqual(fermi.columns)
    const fr = byKey(f.rows, 'region')
    expect(fr.A).toMatchObject({ low: 80_000, likely: 200_000, high: 450_000 })
    expect(fermi.estimate).toEqual({ method: 'fermi', value: 'likely', range: { low: 'low', likely: 'likely', high: 'high' } })

    // 2. Top-down: each region's likely oil spread over its towns by population: the towns add back up to it.
    const oil = table('oil', f.columns, f.rows)
    const td = recipeSql({ kind: 'top-down', fine: 'towns', unit: 'town', parent: 'region', weight: 'pop', coarse: 'oil', total: 'likely', as: 'oil_litres' })
    const t = await sql.run(td.sql, [towns, oil])
    expect(t.columns.map((c) => c.name)).toEqual(td.columns)
    const tt = byKey(t.rows, 'town')
    expect(tt.a1.oil_litres).toBeCloseTo(50_000)
    expect(tt.a2.oil_litres).toBeCloseTo(150_000)
    expect(tt.a2.share).toBeCloseTo(0.75)
    expect((tt.b1.oil_litres as number) + (tt.b2.oil_litres as number)).toBeCloseTo(fr.B.likely as number)

    // 3. Bottom-up: night lights summed per region, fitted against GDP (A, B, D known; C not), applied back.
    const bu = recipeSql({ kind: 'bottom-up', fine: 'towns', unit: 'town', parent: 'region', score: 'lights', coarse: 'regions', truth: 'gdp', as: 'gdp_est' })
    const b = await sql.run(bu.sql, [towns, regions])
    expect(b.columns.map((c) => c.name)).toEqual(bu.columns)
    const bb = byKey(b.rows, 'town')
    // Where the coarse truth is known, the towns add up to it.
    expect((bb.a1.gdp_est as number) + (bb.a2.gdp_est as number)).toBeCloseTo(100)
    expect(bb.d1.gdp_est).toBeCloseTo(160)
    // C has none: its town follows the fitted line, inside its range; the fit is good but not perfect.
    expect(bb.c1.parent_known).toBe(false)
    expect(bb.c1.gdp_est).toBeCloseTo(bb.c1.fitted as number)
    expect(bb.c1.low as number).toBeLessThanOrEqual(bb.c1.fitted as number)
    expect(bb.c1.high as number).toBeGreaterThanOrEqual(bb.c1.fitted as number)
    expect(bb.c1.fit_r2 as number).toBeGreaterThan(0.95)
    expect(bb.c1.fit_r2 as number).toBeLessThan(1)
    expect(bb.c1.fit_units).toBe(3)
  })

  it('refuses anything but plain names, so a recipe never carries SQL of its own', () => {
    expect(() => recipeSql({ kind: 'top-down', fine: 'towns; DROP TABLE x', unit: 'town', parent: 'region', weight: 'pop', coarse: 'oil', total: 'likely' })).toThrow(/fine must be a table or column name/)
    expect(() => recipeSql({ kind: 'fermi', base: 'regions', unit: 'region', factors: [] })).toThrow(/at least one factor/)
    expect(() => recipeSql({ kind: 'nope' } as never)).toThrow(/kind must be/)
  })
})

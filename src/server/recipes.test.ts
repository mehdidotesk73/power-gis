// The estimation pieces (lib/dataset/recipes.ts) run in real DuckDB and compose, end to end:
// - breadth: a tech-savviness composite adjusts population; the adjusted population tracks TV-subscription revenue
//   better than raw population does, and fills the state that doesn't report it;
// - depth: 65+ population adjusted by area type (urban / rural) carries state Medicare users to counties, adding up
//   where the state total is known and following the fitted line where it isn't;
// - deduction: maid services in a city reached from demand and from supply, with a 12-hour day as a physical cap,
//   meeting in the middle.
import { describe, expect, it } from 'vitest'
import { createSqlRunner, type SqlInput, type SqlRun } from './sql'
import { nodeDuckDb } from './testEngine'
import { recipeSql, parseArithmetic, type Recipe } from '../lib/dataset/recipes'
import type { ColumnInfo } from '../lib/dataset/columns'

const table = (alias: string, columns: ColumnInfo[], rows: Record<string, unknown>[]): SqlInput => ({ alias, version: `v${Math.random()}`, columns, rows: async () => rows })
const asInput = (alias: string, r: SqlRun) => table(alias, r.columns, r.rows)
const byKey = (rows: Record<string, unknown>[], k: string) => Object.fromEntries(rows.map((r) => [r[k] as string, r]))
const n = (v: unknown) => v as number

describe('estimation pieces (DuckDB)', () => {
  const sql = createSqlRunner(nodeDuckDb)
  const run = async (r: Recipe, inputs: SqlInput[]) => {
    const made = recipeSql(r)
    const out = await sql.run(made.sql, inputs)
    expect(out.columns.map((c) => c.name)).toEqual(made.columns)
    return { made, out }
  }

  it('breadth: composite → adjust → correlate → fill (a missing state revenue from tech-savvy-adjusted population)', async () => {
    const states = table(
      'states',
      [
        { name: 'state', type: 'string' },
        { name: 'population', type: 'double' },
        { name: 'college', type: 'double' },
        { name: 'tech_jobs', type: 'double' },
        { name: 'farm_share', type: 'double' },
      ],
      [
        { state: 'CA', population: 39, college: 0.36, tech_jobs: 9, farm_share: 0.02 },
        { state: 'TX', population: 30, college: 0.31, tech_jobs: 5, farm_share: 0.03 },
        { state: 'FL', population: 22, college: 0.32, tech_jobs: 3, farm_share: 0.02 },
        { state: 'NY', population: 20, college: 0.39, tech_jobs: 6, farm_share: 0.01 },
        { state: 'PA', population: 13, college: 0.33, tech_jobs: 2, farm_share: 0.03 },
        { state: 'IA', population: 3, college: 0.29, tech_jobs: 0.5, farm_share: 0.12 },
        { state: 'WA', population: 8, college: 0.38, tech_jobs: 4, farm_share: 0.04 },
        { state: 'OH', population: 12, college: 0.3, tech_jobs: 2.5, farm_share: 0.04 },
      ],
    )
    // Tech-savviness: more college and tech jobs, fewer farm jobs; 0 to 1.
    const comp = await run({ kind: 'composite', table: 'states', unit: 'state', parts: [{ column: 'college' }, { column: 'tech_jobs', weight: 2 }, { column: 'farm_share', direction: 'down' }], as: 'tech_savvy' }, [states])
    const tech = byKey(comp.out.rows, 'state')
    expect(n(tech.CA.tech_savvy)).toBeGreaterThan(n(tech.IA.tech_savvy))
    expect(n(tech.IA.tech_savvy)).toBe(0) // last on every part
    // Population adjusted for it.
    const joined = await sql.run('SELECT s.state, s.population, c.tech_savvy FROM states s JOIN comp c USING (state)', [states, asInput('comp', comp.out)])
    const adj = await run({ kind: 'adjust', table: 'j', unit: 'state', measure: 'population', by: 'tech_savvy', strength: 1, as: 'savvy_population' }, [asInput('j', joined)])
    // Revenue follows the adjusted population (with a little noise); Ohio doesn't report it.
    const noise = [1.02, 0.98, 1.01, 0.99, 1.03, 0.97, 1.0, 1.0]
    const revenue = adj.out.rows.map((r, i) => ({ state: r.state, population: r.population, savvy_population: r.savvy_population, tv_revenue: r.state === 'OH' ? null : 3 * n(r.savvy_population) * noise[i] }))
    const tv = table('tv', [{ name: 'state', type: 'string' }, { name: 'population', type: 'double' }, { name: 'savvy_population', type: 'double' }, { name: 'tv_revenue', type: 'double' }], revenue)
    // Which side tracks revenue better? The adjusted one.
    const raw = await run({ kind: 'correlate', table: 'tv', x: 'population', y: 'tv_revenue' }, [tv])
    const adjusted = await run({ kind: 'correlate', table: 'tv', x: 'savvy_population', y: 'tv_revenue' }, [tv])
    expect(n(adjusted.out.rows[0].r2)).toBeGreaterThan(n(raw.out.rows[0].r2))
    expect(n(adjusted.out.rows[0].r2)).toBeGreaterThan(0.99)
    expect(adjusted.out.rows[0].n).toBe(7)
    // Fill Ohio from it.
    const fill = await run({ kind: 'fill', table: 'tv', unit: 'state', x: 'savvy_population', y: 'tv_revenue' }, [tv])
    const f = byKey(fill.out.rows, 'state')
    const ohio = 3 * n(f.OH.savvy_population)
    expect(f.OH.estimated).toBe(true)
    expect(n(f.OH.tv_revenue_filled)).toBeCloseTo(ohio, -0.5)
    expect(n(f.OH.low)).toBeLessThanOrEqual(n(f.OH.tv_revenue_filled))
    expect(n(f.OH.high)).toBeGreaterThanOrEqual(n(f.OH.tv_revenue_filled))
    expect(f.CA).toMatchObject({ estimated: false, tv_revenue_filled: f.CA.tv_revenue, low: f.CA.tv_revenue })
    expect(fill.made.estimate).toEqual({ method: 'fill', value: 'tv_revenue_filled', range: { low: 'low', likely: 'tv_revenue_filled', high: 'high' } })
  })

  it('depth: 65+ population adjusted by area type carries state Medicare users to counties (scale), and correlate per class', async () => {
    const counties = table(
      'counties',
      [
        { name: 'fips', type: 'string' },
        { name: 'state', type: 'string' },
        { name: 'area', type: 'string' },
        { name: 'pop65', type: 'double' },
      ],
      [
        { fips: '01', state: 'A', area: 'urban', pop65: 100 },
        { fips: '02', state: 'A', area: 'rural', pop65: 50 },
        { fips: '03', state: 'B', area: 'urban', pop65: 300 },
        { fips: '04', state: 'B', area: 'rural', pop65: 60 },
        { fips: '05', state: 'C', area: 'rural', pop65: 120 },
        { fips: '06', state: 'D', area: 'urban', pop65: 200 },
        { fips: '07', state: 'D', area: 'rural', pop65: 100 },
      ],
    )
    // People retire later in cities: fewer of the 65+ there are on Medicare yet.
    const adj = await run({ kind: 'adjust', table: 'counties', unit: 'fips', measure: 'pop65', by: 'area', factors: { urban: 0.8, rural: 1.1 }, as: 'medicare_age' }, [counties])
    const a = byKey(adj.out.rows, 'fips')
    expect(a['01']).toMatchObject({ multiplier: 0.8, medicare_age: 80 })
    expect(a['02'].medicare_age).toBeCloseTo(55)
    const withState = await sql.run('SELECT c.fips, c.state, c.area, a.medicare_age FROM counties c JOIN adj a USING (fips)', [counties, asInput('adj', adj.out)])
    // State totals (C unknown), close to 0.9 × the adjusted population.
    const states = table('states', [{ name: 'state', type: 'string' }, { name: 'medicare', type: 'double' }], [
      { state: 'A', medicare: 122 },
      { state: 'B', medicare: 300 },
      { state: 'C', medicare: null },
      { state: 'D', medicare: 250 },
    ])
    const scale = await run({ kind: 'scale', fine: 'fine', unit: 'fips', parent: 'state', proxy: 'medicare_age', coarse: 'states', total: 'medicare', as: 'medicare_users' }, [asInput('fine', withState), states])
    const s = byKey(scale.out.rows, 'fips')
    expect(n(s['01'].medicare_users) + n(s['02'].medicare_users)).toBeCloseTo(122)
    expect(n(s['06'].medicare_users) + n(s['07'].medicare_users)).toBeCloseTo(250)
    expect(n(s['01'].share)).toBeCloseTo(80 / 135)
    expect(s['05'].estimated).toBe(true)
    expect(n(s['05'].low)).toBeLessThanOrEqual(n(s['05'].medicare_users))
    expect(n(s['05'].high)).toBeGreaterThanOrEqual(n(s['05'].medicare_users))
    expect(n(s['05'].fit_r2)).toBeGreaterThan(0.95)
    expect(s['05'].fit_n).toBe(3)
    // Correlate per class: one line each.
    const both = await sql.run('SELECT c.fips, c.area, c.pop65, a.medicare_age FROM counties c JOIN adj a USING (fips)', [counties, asInput('adj', adj.out)])
    const per = await run({ kind: 'correlate', table: 'c', x: 'pop65', y: 'medicare_age', group: 'area' }, [asInput('c', both)])
    expect(per.out.rows.map((r) => [r.area, r.slope])).toEqual([
      ['rural', expect.closeTo(1.1, 6)],
      ['urban', expect.closeTo(0.8, 6)],
    ])
  })

  it('deduction: maid services from demand and from supply, a 12-hour day as a cap, meeting in the middle', async () => {
    const cities = table('cities', [{ name: 'city', type: 'string' }, { name: 'population', type: 'double' }], [{ city: 'X', population: 100_000 }])
    const { made, out } = await run(
      {
        kind: 'deduce',
        base: 'cities',
        unit: 'city',
        steps: [
          { name: 'persons_per_home', low: 2.2, likely: 2.5, high: 2.8 },
          { name: 'homes', expr: 'population / persons_per_home' },
          { name: 'share_hiring', low: 0.05, likely: 0.1, high: 0.15 },
          { name: 'cleanings_a_year', low: 12, likely: 24, high: 52 },
          { name: 'sqft', low: 1200, likely: 1800, high: 2500 },
          { name: 'hours_per_sqft', low: 0.0015, likely: 0.002, high: 0.003 },
          { name: 'hours_needed', expr: 'homes × share_hiring × cleanings_a_year × sqft × hours_per_sqft' },
          { name: 'hours_a_day', low: 6, likely: 8, high: 14 },
          { name: 'days_a_year', low: 220, likely: 250, high: 280 },
          { name: 'hours_per_maid', expr: 'min(hours_a_day, 12) * days_a_year' },
          { name: 'maids_by_demand', expr: 'hours_needed / hours_per_maid' },
          { name: 'cleaners_per_1000', low: 1, likely: 2, high: 3 },
          { name: 'maids_by_supply', expr: 'population * cleaners_per_1000 / 1000' },
        ],
        meet: { a: 'maids_by_demand', b: 'maids_by_supply', as: 'maids' },
      },
      [cities],
    )
    const x = out.rows[0]
    expect(n(x.homes_likely)).toBeCloseTo(40_000)
    expect(n(x.hours_needed_likely)).toBeCloseTo(345_600)
    // The cap holds: the high day is 14 hours, but a maid works at most 12.
    expect(n(x.hours_per_maid_high)).toBeCloseTo(12 * 280)
    expect(n(x.maids_by_demand_likely)).toBeCloseTo(172.8)
    expect(n(x.maids_by_supply_likely)).toBeCloseTo(200)
    for (const k of ['homes', 'hours_needed', 'maids_by_demand', 'maids']) {
      expect(n(x[`${k}_low`])).toBeLessThanOrEqual(n(x[`${k}_likely`]))
      expect(n(x[`${k}_likely`])).toBeLessThanOrEqual(n(x[`${k}_high`]))
    }
    expect(n(x.maids_likely)).toBeCloseTo(Math.sqrt(172.8 * 200))
    expect(n(x.agreement)).toBeCloseTo(0.864)
    expect(x.overlap).toBe(true)
    expect(made.estimate).toEqual({ method: 'deduce', value: 'maids_likely', range: { low: 'maids_low', likely: 'maids_likely', high: 'maids_high' } })
  })

  it('takes names and plain arithmetic only, so a piece never carries SQL of its own', () => {
    expect(() => recipeSql({ kind: 'fill', table: 'tv; DROP TABLE x', unit: 'state', x: 'a', y: 'b' })).toThrow(/table must be a table or column name/)
    expect(() => parseArithmetic('a + b; drop')).toThrow(/Unexpected ";"/)
    expect(() => parseArithmetic('sqrt(a)')).toThrow(/Unexpected "\("/)
    expect(() => recipeSql({ kind: 'deduce', base: 'c', unit: 'u', steps: [{ name: 'x', expr: 'y +' }] })).toThrow(/ends too early/)
    expect(() => recipeSql({ kind: 'deduce', base: 'c', unit: 'u', steps: [{ name: 'x', likely: 1 }], meet: { a: 'x', b: 'nope' } })).toThrow(/meet must name two of the steps/)
    expect(() => recipeSql({ kind: 'adjust', table: 't', unit: 'u', measure: 'm', by: 'b' })).toThrow(/factors .* or strength/)
    // A class name is data, quoted safely.
    expect(recipeSql({ kind: 'adjust', table: 't', unit: 'u', measure: 'm', by: 'b', factors: { "o'clock": 2 } }).sql).toContain("WHEN 'o''clock' THEN")
    expect(() => recipeSql({ kind: 'nope' } as never)).toThrow(/kind must be one of/)
  })
})

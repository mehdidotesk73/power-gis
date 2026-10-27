import { describe, expect, it } from 'vitest'
import { checkSelect, createSqlRunner, type SqlInput } from './sql'
import { nodeDuckDb } from './testEngine'
import { profileRows } from '../lib/dataset/profile'

const plants: SqlInput = {
  alias: 'plants',
  version: 'v1',
  columns: [
    { name: 'name', type: 'string' },
    { name: 'lat', type: 'double' },
    { name: 'lon', type: 'double' },
    { name: 'mw', type: 'int' },
    { name: 'fips', type: 'string' },
    { name: 'built', type: 'datetime' },
  ],
  rows: async () => [
    { name: "O'Hare", lat: '41.9', lon: '-87.9', mw: '500', fips: '17031', built: '1990-05-01' },
    { name: 'B', lat: '35.1', lon: '-90.0', mw: '1200', fips: '47157', built: null },
    { name: 'C', lat: '', lon: '-90.0', mw: '300', fips: '47157', built: '2001-01-01T00:00:00Z' },
  ],
}
const flows: SqlInput = {
  alias: 'flows',
  version: 'v1',
  columns: [
    { name: 'fips', type: 'string' },
    { name: 'flow', type: 'vector' },
    { name: 'area', type: 'region' },
  ],
  rows: async () => [{ fips: '47157', flow: { u: 1, v: 2 }, area: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }],
}

describe('sql transforms (DuckDB)', () => {
  const sql = createSqlRunner(nodeDuckDb)

  it('builds points and vectors with the helpers, typed on the way out', async () => {
    const r = await sql.run('SELECT name, point(lat, lon) AS location, vector(mw, 0) AS output, mw * 2 AS mw2, built FROM plants ORDER BY name', [plants])
    expect(r.columns).toEqual([
      { name: 'name', type: 'string' },
      { name: 'location', type: 'point' },
      { name: 'output', type: 'vector' },
      { name: 'mw2', type: 'int' },
      { name: 'built', type: 'datetime' },
    ])
    expect(r.rows[0]).toEqual({ name: 'B', location: '{"type":"Point","coordinates":[-90.0,35.1]}', output: { u: 1200, v: 0 }, mw2: 2400, built: null })
    expect(r.rows[2]).toMatchObject({ name: "O'Hare", built: '1990-05-01T00:00:00.000Z' })
    expect(r.rows[1].location).toBeNull() // no latitude → no point
    expect(r.rowCount).toBe(3)
  })

  it('joins inputs, keeps geometry and vectors, and previews with a limit', async () => {
    const r = await sql.run('SELECT p.name, f.flow, f.area FROM plants p JOIN flows f USING (fips)', [plants, flows], 1)
    expect(r.rowCount).toBe(2)
    expect(r.rows).toHaveLength(1)
    expect(r.columns.map((c) => c.type)).toEqual(['string', 'vector', 'region'])
    expect(JSON.parse(r.rows[0].area as string).type).toBe('Polygon')
  })

  it('reports SQL errors and non-SELECT statements readably', async () => {
    await expect(sql.run('SELECT nope FROM plants', [plants])).rejects.toThrow(/nope/)
    // A table that isn't an input: say which tables there are.
    await expect(sql.run('SELECT * FROM electric_utilities', [{ ...plants, label: 'My plants' }])).rejects.toThrow('No table electric_utilities. Tables you can use: plants (My plants).')
    await expect(sql.run('DROP TABLE plants', [plants])).rejects.toThrow(/one SELECT/)
    await expect(sql.run('SELECT 1; SELECT 2', [plants])).rejects.toThrow(/one SELECT/)
    await expect(sql.run('SELECT 1', [{ ...plants, alias: '1bad' }])).rejects.toThrow(/table name/)
    expect(checkSelect('  WITH x AS (SELECT 1) SELECT * FROM x;  ')).toBe('WITH x AS (SELECT 1) SELECT * FROM x')
    // Semicolons and quotes inside comments and strings don't count.
    expect(checkSelect("-- one row; per county\nSELECT 'a;b' AS x /* don't; */ ; -- done")).toBe("-- one row; per county\nSELECT 'a;b' AS x /* don't; */  -- done")
    await expect(sql.run('SELECT mw FROM plants -- trailing comment', [plants], 1)).resolves.toMatchObject({ rowCount: 3 })
    // sum() of integers is a HUGEINT, decimals keep their scale: both come back as plain numbers.
    const nums = await sql.run("SELECT sum(x) AS s, 12.345::DECIMAL(10,3) AS d, -0.5::DECIMAL(4,1) AS n FROM (VALUES (1::BIGINT), (-5::BIGINT)) t(x)", [plants])
    expect(nums.rows).toEqual([{ s: -4, d: 12.345, n: -0.5 }])
  })

  it('keeps one engine copy per dataset whatever the alias, reloads it on change, and drops old ones over budget', async () => {
    let loads = 0
    const counting = async () => {
      const e = await nodeDuckDb()
      return { ...e, insert: (t: string, c: Parameters<NonNullable<typeof e.insert>>[1]) => (t === '__stage' && loads++, e.insert!(t, c)) }
    }
    const runner = createSqlRunner(counting, { cellBudget: 20 })
    const ds = (alias: string, version = 'v1', key = 'plants-id'): SqlInput => ({ ...plants, alias, key, version })
    expect((await runner.run('SELECT count(*) AS n FROM p', [ds('p')])).rows[0].n).toBe(3)
    expect((await runner.run('SELECT count(*) AS n FROM q', [ds('q')])).rows[0].n).toBe(3)
    expect((await runner.run('SELECT a.name FROM a JOIN b USING (name) ORDER BY 1', [ds('a'), ds('b', 'v1', 'other-id')])).rows).toHaveLength(3)
    expect(loads).toBe(2) // plants once (aliases p, q, a), the other dataset once
    await runner.run('SELECT * FROM p', [ds('p', 'v2')])
    expect(loads).toBe(3) // a new version reloads
    // Budget 20 cells: plants (18) and the other copy (18) can't both stay, so each use evicts the other.
    await runner.run('SELECT * FROM b', [ds('b', 'v1', 'other-id')])
    await runner.run('SELECT * FROM p', [ds('p', 'v2')])
    expect(loads).toBe(5)
  })

  it('pages with one run, and counts correctly past the end', async () => {
    const page = await sql.run('SELECT name FROM plants ORDER BY name', [plants], 2, 1)
    expect(page).toMatchObject({ rowCount: 3, rows: [{ name: 'C' }, { name: "O'Hare" }] })
    expect(page.columns.map((c) => c.name)).toEqual(['name'])
    expect(await sql.run('SELECT name FROM plants', [plants], 2, 10)).toMatchObject({ rowCount: 3, rows: [] })
    expect(await sql.run('SELECT name FROM plants WHERE false', [plants], 2)).toMatchObject({ rowCount: 0, rows: [] })
  })

  it('profiles a table', async () => {
    const rows = await plants.rows()
    const p = profileRows(rows, plants.columns)
    expect(p.rowCount).toBe(3)
    expect(p.columns.find((c) => c.name === 'mw')).toMatchObject({ filled: 3, distinct: 3, min: 300, max: 1200 })
    expect(p.columns.find((c) => c.name === 'lat')).toMatchObject({ filled: 2 })
    expect(p.columns.find((c) => c.name === 'fips')).toMatchObject({ distinct: 2 })
    expect(p.completeness).toBeCloseTo(16 / 18)
  })
})

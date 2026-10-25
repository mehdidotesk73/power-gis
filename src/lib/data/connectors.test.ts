import { describe, expect, it } from 'vitest'
import { LocalFileConnector, StaticFileConnector, requireColumns } from './connectors'
import { utilityRowsFromRecords } from '../utilities'

const CSV = 'utility_id_eia,utility_name,county_fips,short_form\n195,Alabama Power Co,1001,False\n'
const file = (name: string, text = CSV) => ({ name, text: async () => text })

describe('StaticFileConnector', () => {
  it('fetches <base><dir>/<table>.csv', async () => {
    const urls: string[] = []
    const src = new StaticFileConnector(['utility_counties'], '/app/', 'data', async (u) => {
      urls.push(u)
      return { ok: true, status: 200, text: async () => CSV }
    })
    const rows = await src.readTable('utility_counties')
    expect(urls).toEqual(['/app/data/utility_counties.csv'])
    expect(rows[0].utility_name).toBe('Alabama Power Co')
    await expect(src.readTable('other')).rejects.toThrow('No built-in table')
  })

  it('reports HTTP failures', async () => {
    const src = new StaticFileConnector(['t'], '/', 'data', async () => ({ ok: false, status: 404, text: async () => '' }))
    await expect(src.readTable('t')).rejects.toThrow('t.csv: HTTP 404')
  })
})

describe('LocalFileConnector', () => {
  it('maps files to tables by name, or by explicit binding', async () => {
    const byName = new LocalFileConnector([file('utility_counties.csv')])
    expect(await byName.listTables()).toEqual(['utility_counties'])
    const bound = new LocalFileConnector([], { utility_counties: file('my export.csv') })
    expect((await bound.readTable('utility_counties'))[0].county_fips).toBe('1001')
    expect(bound.label).toBe('my export.csv')
    await expect(bound.readTable('missing')).rejects.toThrow('Choose a CSV')
  })
})

describe('records → utility rows', () => {
  it('accepts CSV strings and typed database values alike', () => {
    const [fromCsv] = utilityRowsFromRecords([{ utility_id_eia: '195', county_fips: '1001', short_form: 'False', state_customers: '' }])
    const [fromDb] = utilityRowsFromRecords([{ utility_id_eia: 195, county_fips: '01001', short_form: true, state_customers: 42 }])
    expect(fromCsv).toMatchObject({ utility_id_eia: 195, county_fips: '01001', short_form: false, state_customers: null })
    expect(fromDb).toMatchObject({ utility_id_eia: 195, county_fips: '01001', short_form: true, state_customers: 42 })
  })

  it('names missing columns', () => {
    expect(() => requireColumns([{ utility_name: 'x' }], ['utility_id_eia', 'county_fips'], 'utility_counties')).toThrow(
      'missing columns: utility_id_eia, county_fips',
    )
    expect(() => requireColumns([], ['a'], 't')).toThrow('has no rows')
  })
})

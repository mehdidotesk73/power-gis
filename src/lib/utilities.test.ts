import { describe, expect, it } from 'vitest'
import { buildCountyLayer, parseUtilityCounties, utilitiesFromRows } from './utilities'
import { inferFields, typeName } from './schema'

const CSV = `utility_id_eia,utility_name,entity_type,state,county,county_fips,counties_in_state,state_customers,state_sales_mwh,state_revenue_usd,short_form,report_year
195,Alabama Power Co,Investor Owned,AL,Autauga,01001,59,1557733,52177426,7137428000,False,2025
3222,Central Alabama Electric Coop,Cooperative,AL,Autauga,01001,10,48071,743983,125213000,False,2025
195,Alabama Power Co,Investor Owned,AL,Baldwin,01003,59,1557733,52177426,7137428000,False,2025
30517,"Pioneer Electric Coop, Inc - (AL)",Cooperative,AL,Baldwin,01003,9,,,,True,2025
9999,Nowhere Light,Municipal,AL,Ghost,01999,1,10,,,False,2025
`

const square = (x: number) => ({ type: 'Polygon' as const, coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] })
const counties = [
  { type: 'Feature' as const, id: '01001', geometry: square(0), properties: { name: 'Autauga' } },
  { type: 'Feature' as const, id: '01003', geometry: square(2), properties: { name: 'Baldwin' } },
  { type: 'Feature' as const, id: '01005', geometry: square(4), properties: { name: 'Barbour' } },
]

describe('utility CSV', () => {
  const rows = parseUtilityCounties(CSV)

  it('parses types and keeps FIPS as zero-padded strings', () => {
    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatchObject({ utility_id_eia: 195, county_fips: '01001', state_customers: 1557733, short_form: false })
    expect(rows[3]).toMatchObject({ utility_name: 'Pioneer Electric Coop, Inc - (AL)', state_customers: null, short_form: true })
  })

  it('joins rows onto county polygons', () => {
    const { layer, unmatchedFips } = buildCountyLayer(rows, counties)
    expect(unmatchedFips).toEqual(['01999'])
    const [autauga, baldwin, barbour] = layer.features.map((f) => f.properties)
    expect(autauga).toMatchObject({ fips: '01001', state: 'AL', utility_count: 2, served_by_cooperative: true, served_by_investor_owned: true })
    expect((autauga.utilities as { utility_name: string }[])[0].utility_name).toBe('Alabama Power Co') // largest first
    expect(baldwin.entity_type_counts).toEqual({ 'Investor Owned': 1, Cooperative: 1 })
    expect(barbour).toMatchObject({ utility_count: 0, dominant_entity_type: null, served_by_public_power: false })
  })

  it('declares a schema that matches the data', () => {
    const { layer } = buildCountyLayer(rows, counties)
    const declared = Object.fromEntries(layer.fields.map((f) => [f.name, typeName(f.type)]))
    const inferred = Object.fromEntries(inferFields(layer.features.slice(0, 1)).map((f) => [f.name, typeName(f.type)]))
    expect(inferred.utility_count).toBe(declared.utility_count)
    expect(inferred.served_by_cooperative).toBe(declared.served_by_cooperative)
    expect(declared.utilities).toMatch(/^list<struct\{utility_id_eia: int/)
  })

  it('builds the utility list', () => {
    const us = utilitiesFromRows(rows)
    const apc = us.find((u) => u.utility_id_eia === 195)!
    expect(apc.county_fips).toEqual(['01001', '01003'])
    expect(apc.customers).toBe(1557733) // state figure counted once, not per county
  })
})

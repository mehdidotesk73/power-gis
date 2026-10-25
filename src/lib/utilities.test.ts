import { describe, expect, it } from 'vitest'
import { parseUtilityCounties, utilitiesFromRows } from './utilities'

const CSV = `utility_id_eia,utility_name,entity_type,state,county,county_fips,counties_in_state,state_customers,state_sales_mwh,state_revenue_usd,short_form,report_year
195,Alabama Power Co,Investor Owned,AL,Autauga,01001,59,1557733,52177426,7137428000,False,2025
3222,Central Alabama Electric Coop,Cooperative,AL,Autauga,01001,10,48071,743983,125213000,False,2025
195,Alabama Power Co,Investor Owned,AL,Baldwin,01003,59,1557733,52177426,7137428000,False,2025
30517,"Pioneer Electric Coop, Inc - (AL)",Cooperative,AL,Baldwin,01003,9,,,,True,2025
9999,Nowhere Light,Municipal,AL,Ghost,01999,1,10,,,False,2025
`

describe('utility CSV', () => {
  const rows = parseUtilityCounties(CSV)

  it('parses types and keeps FIPS as zero-padded strings', () => {
    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatchObject({ utility_id_eia: 195, county_fips: '01001', state_customers: 1557733, short_form: false })
    expect(rows[3]).toMatchObject({ utility_name: 'Pioneer Electric Coop, Inc - (AL)', state_customers: null, short_form: true })
  })

  it('builds the utility list', () => {
    const us = utilitiesFromRows(rows)
    const apc = us.find((u) => u.utility_id_eia === 195)!
    expect(apc.county_fips).toEqual(['01001', '01003'])
    expect(apc.customers).toBe(1557733) // state figure counted once, not per county
  })
})

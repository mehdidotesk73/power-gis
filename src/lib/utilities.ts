// The first dataset: US electric utilities by county (EIA Form 861).
// Parses public/data/utility_counties.csv and joins it onto county polygons
// to make a county "region" layer whose features carry their utility list.

import Papa from 'papaparse'
import type { Feature, Geometry } from 'geojson'
import { dictOf, listOf, structOf, type FieldDef, type LayerData, type LayerFeature } from './schema'
import { STATES } from './states'

export interface UtilityCountyRow {
  utility_id_eia: number
  utility_name: string
  entity_type: string
  state: string
  county: string
  county_fips: string
  counties_in_state: number
  state_customers: number | null
  state_sales_mwh: number | null
  state_revenue_usd: number | null
  short_form: boolean
  report_year: number
}

export interface Utility {
  utility_id_eia: number
  utility_name: string
  entity_type: string
  states: string[]
  county_fips: string[]
  customers: number | null
}

/** Government-owned ownership types, grouped as "public power". */
export const PUBLIC_POWER = new Set(['Municipal', 'Political Subdivision', 'State', 'Federal', 'Municipal Mktg Authority'])

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function parseUtilityCounties(csv: string): UtilityCountyRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true, dynamicTyping: false })
  return parsed.data.map((r) => ({
    utility_id_eia: Number(r.utility_id_eia),
    utility_name: r.utility_name,
    entity_type: r.entity_type || 'Unknown',
    state: r.state,
    county: r.county,
    county_fips: r.county_fips.padStart(5, '0'),
    counties_in_state: num(r.counties_in_state) ?? 0,
    state_customers: num(r.state_customers),
    state_sales_mwh: num(r.state_sales_mwh),
    state_revenue_usd: num(r.state_revenue_usd),
    short_form: r.short_form === 'True' || r.short_form === 'true',
    report_year: Number(r.report_year),
  }))
}

export function utilitiesFromRows(rows: UtilityCountyRow[]): Utility[] {
  const byId = new Map<number, Utility & { _custByState: Map<string, number | null> }>()
  for (const r of rows) {
    let u = byId.get(r.utility_id_eia)
    if (!u) {
      u = { utility_id_eia: r.utility_id_eia, utility_name: r.utility_name, entity_type: r.entity_type, states: [], county_fips: [], customers: null, _custByState: new Map() }
      byId.set(r.utility_id_eia, u)
    }
    if (!u.states.includes(r.state)) u.states.push(r.state)
    u.county_fips.push(r.county_fips)
    u._custByState.set(r.state, r.state_customers)
  }
  return [...byId.values()]
    .map(({ _custByState, ...u }) => {
      const vals = [..._custByState.values()].filter((v): v is number => v !== null)
      return { ...u, states: u.states.sort(), customers: vals.length ? vals.reduce((a, b) => a + b, 0) : null }
    })
    .sort((a, b) => a.utility_name.localeCompare(b.utility_name))
}

export const UTILITY_STRUCT: FieldDef[] = [
  { name: 'utility_id_eia', type: 'int', alias: 'EIA utility ID' },
  { name: 'utility_name', type: 'string', alias: 'Utility' },
  { name: 'entity_type', type: 'string', alias: 'Ownership' },
  { name: 'state_customers', type: 'int', alias: 'Customers (state-wide)' },
  { name: 'counties_in_state', type: 'int', alias: 'Counties served (state)' },
]

export const COUNTY_FIELDS: FieldDef[] = [
  { name: 'fips', type: 'string', alias: 'County FIPS' },
  { name: 'county', type: 'string', alias: 'County' },
  { name: 'state', type: 'string', alias: 'State' },
  { name: 'state_name', type: 'string', alias: 'State name' },
  { name: 'utility_count', type: 'int', alias: 'Utilities serving county' },
  { name: 'dominant_entity_type', type: 'string', alias: 'Most common ownership' },
  { name: 'served_by_cooperative', type: 'boolean', alias: 'Cooperative present' },
  { name: 'served_by_investor_owned', type: 'boolean', alias: 'Investor-owned present' },
  { name: 'served_by_public_power', type: 'boolean', alias: 'Public power present' },
  { name: 'entity_type_counts', type: dictOf('int'), alias: 'Utilities by ownership' },
  { name: 'utilities', type: listOf(structOf(UTILITY_STRUCT)), alias: 'Utilities' },
  { name: 'report_year', type: 'int', alias: 'EIA-861 report year' },
]

/** Join utility rows onto county polygons (features with 5-digit FIPS ids). */
export function buildCountyLayer(
  rows: UtilityCountyRow[],
  counties: Feature<Geometry, { name?: string }>[],
): { layer: LayerData; unmatchedFips: string[] } {
  const byFips = new Map<string, UtilityCountyRow[]>()
  for (const r of rows) {
    if (!byFips.has(r.county_fips)) byFips.set(r.county_fips, [])
    byFips.get(r.county_fips)!.push(r)
  }
  const year = rows[0]?.report_year ?? null
  const seen = new Set<string>()
  const features: LayerFeature[] = counties.map((c) => {
    const fips = String(c.id).padStart(5, '0')
    seen.add(fips)
    const here = byFips.get(fips) ?? []
    const counts: Record<string, number> = {}
    for (const r of here) counts[r.entity_type] = (counts[r.entity_type] ?? 0) + 1
    const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
    const st = STATES[fips.slice(0, 2)]
    return {
      type: 'Feature',
      id: fips,
      geometry: c.geometry,
      properties: {
        fips,
        county: c.properties?.name ?? here[0]?.county ?? fips,
        state: st?.abbr ?? here[0]?.state ?? null,
        state_name: st?.name ?? null,
        utility_count: here.length,
        dominant_entity_type: dominant,
        served_by_cooperative: here.some((r) => r.entity_type === 'Cooperative'),
        served_by_investor_owned: here.some((r) => r.entity_type === 'Investor Owned'),
        served_by_public_power: here.some((r) => PUBLIC_POWER.has(r.entity_type)),
        entity_type_counts: counts,
        utilities: here
          .map((r) => ({
            utility_id_eia: r.utility_id_eia,
            utility_name: r.utility_name,
            entity_type: r.entity_type,
            state_customers: r.state_customers,
            counties_in_state: r.counties_in_state,
          }))
          .sort((a, b) => (b.state_customers ?? -1) - (a.state_customers ?? -1)),
        report_year: year,
      },
    }
  })
  return {
    layer: {
      id: 'utility-counties',
      name: 'Electric utilities by county',
      geometry: 'region',
      idField: 'fips',
      titleField: 'county',
      fields: COUNTY_FIELDS,
      features,
      source: { label: 'EIA Form 861 Service Territory (via PUDL)', url: 'https://www.eia.gov/electricity/data/eia861/', year: year ?? undefined },
    },
    unmatchedFips: [...byFips.keys()].filter((f) => !seen.has(f)),
  }
}

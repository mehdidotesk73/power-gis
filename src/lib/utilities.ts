// The first dataset: US electric utilities by county (EIA Form 861).
// Typed rows and the per-utility list behind utility search. (Drawing the
// table on the map is generic — see lib/layers.)

import { parseCsv } from './data/csv'
import { COUNTY_SUCCESSORS } from './layers/binding'

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

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const bool = (v: unknown): boolean => v === true || v === 1 || /^(true|1)$/i.test(str(v))

/**
 * Typed rows from raw records — CSV rows (all strings) or database rows
 * (numbers/booleans already typed) both work.
 */
const canonicalFips = (f: string) => COUNTY_SUCCESSORS[f.padStart(5, '0')] ?? f.padStart(5, '0')

export function utilityRowsFromRecords(records: Record<string, unknown>[]): UtilityCountyRow[] {
  return records.map((r) => ({
    utility_id_eia: Number(r.utility_id_eia),
    utility_name: str(r.utility_name),
    entity_type: str(r.entity_type) || 'Unknown',
    state: str(r.state),
    county: str(r.county),
    county_fips: canonicalFips(str(r.county_fips)),
    counties_in_state: num(r.counties_in_state) ?? 0,
    state_customers: num(r.state_customers),
    state_sales_mwh: num(r.state_sales_mwh),
    state_revenue_usd: num(r.state_revenue_usd),
    short_form: bool(r.short_form),
    report_year: Number(r.report_year),
  }))
}

/** Columns a utility-county table must have. */
export const UTILITY_COUNTY_COLUMNS = ['utility_id_eia', 'utility_name', 'county_fips'] as const

export function parseUtilityCounties(csv: string): UtilityCountyRow[] {
  return utilityRowsFromRecords(parseCsv(csv))
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

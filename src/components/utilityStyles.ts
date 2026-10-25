// The built-in utilities-by-county data source: a generic data source with
// preset layers that show the dataset well.
import type { DataRecord } from '../lib/data/connectors'
import { PUBLIC_POWER } from '../lib/utilities'
import { newId } from '../lib/datasource/datasource'
import { ROWS, VALUE, type LayerSpec } from '../lib/datasource/layer'
import type { GeometryBinding } from '../lib/datasource/binding'

export const OWNERSHIP_COLORS: Record<string, string> = {
  'Investor Owned': '#4e79a7',
  Cooperative: '#59a14f',
  Municipal: '#f28e2b',
  'Political Subdivision': '#edc948',
  State: '#b07aa1',
  Federal: '#e15759',
  'Municipal Mktg Authority': '#ff9da7',
  'Community Choice Aggregator': '#76b7b2',
  'Retail Power Marketer': '#9c755f',
  'Wholesale Power Marketer': '#c9b18f',
  Transmission: '#8cd17d',
  'Behind the Meter': '#d4a6c8',
  Unknown: '#bab0ac',
}

export const UTILITY_TABLE = 'utility_counties'
export const UTILITY_NAME = 'Electric utilities by county (EIA-861)'
export const UTILITY_BINDING: GeometryBinding = { kind: 'boundary', column: 'county_fips', boundary: 'us-counties', includeEmpty: true }

/** Adds yes/no ownership columns so a layer can hatch counties where a type is present. */
export function withOwnershipFlags(records: DataRecord[]): DataRecord[] {
  return records.map((r) => ({
    ...r,
    cooperative: r.entity_type === 'Cooperative',
    public_power: PUBLIC_POWER.has(String(r.entity_type)),
  }))
}

const outline = { color: '#ffffff', width: 0.3, opacity: 0.7 }
const clear = { opacity: { kind: 'constant' as const, value: 0 }, outline: { color: '#ffffff', width: 0, opacity: 0 } }

export function utilityLayers(datasourceId: string): LayerSpec[] {
  return [
    {
      id: newId('l'),
      datasourceId,
      name: 'Number of utilities',
      visible: true,
      kind: 'scalar',
      column: ROWS,
      aggregation: 'count',
      style: {
        color: { kind: 'colormap', field: VALUE, colormap: 'viridis', domain: [0, 10] },
        opacity: { kind: 'constant', value: 0.75 },
        pattern: { kind: 'none' },
        outline,
      },
    },
    {
      id: newId('l'),
      datasourceId,
      name: 'Most common ownership',
      visible: false,
      kind: 'scalar',
      column: 'entity_type',
      aggregation: 'mode',
      style: {
        color: { kind: 'categorical', field: VALUE, colors: OWNERSHIP_COLORS, maxCategories: 8 },
        opacity: { kind: 'constant', value: 0.75 },
        pattern: { kind: 'none' },
        outline,
      },
    },
    {
      // Pattern only (transparent fill): stacks on top of either layer above.
      id: newId('l'),
      datasourceId,
      name: 'Co-op present (hatch)',
      visible: false,
      kind: 'scalar',
      column: 'cooperative',
      aggregation: 'any',
      style: {
        color: { kind: 'constant', color: '#000000' },
        ...clear,
        pattern: { kind: 'field', field: VALUE, patterns: { true: 'hatch' }, color: '#1b5e20', opacity: 0.9 },
      },
    },
  ]
}

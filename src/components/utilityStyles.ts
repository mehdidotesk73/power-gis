// Style presets for the utilities-by-county layer.
import type { ScalarStyle, VectorStyle } from '../lib/style'

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

const outline = { color: '#ffffff', width: 0.3, opacity: 0.7 }

export const UTILITY_PRESETS: { id: string; label: string; style: ScalarStyle }[] = [
  {
    id: 'count',
    label: 'Number of utilities',
    style: {
      color: { kind: 'colormap', field: 'utility_count', colormap: 'viridis', domain: [0, 10] },
      opacity: { kind: 'constant', value: 0.75 },
      pattern: { kind: 'none' },
      outline,
    },
  },
  {
    id: 'ownership',
    label: 'Most common ownership type',
    style: {
      color: { kind: 'categorical', field: 'dominant_entity_type', colors: OWNERSHIP_COLORS, maxCategories: 8 },
      opacity: { kind: 'constant', value: 0.75 },
      pattern: { kind: 'none' },
      outline,
    },
  },
  {
    id: 'count-coop',
    label: 'Number of utilities, hatched where a co-op serves',
    style: {
      color: { kind: 'colormap', field: 'utility_count', colormap: 'ylOrRd', domain: [0, 10] },
      opacity: { kind: 'constant', value: 0.7 },
      pattern: { kind: 'field', field: 'served_by_cooperative', patterns: { true: 'hatch' }, color: '#1b5e20', opacity: 0.9 },
      outline,
    },
  },
  {
    id: 'public-power',
    label: 'Public power present',
    style: {
      color: { kind: 'categorical', field: 'served_by_public_power', colors: { true: '#f28e2b', false: '#dfe3e8' } },
      opacity: { kind: 'constant', value: 0.75 },
      pattern: { kind: 'field', field: 'served_by_investor_owned', patterns: { true: 'dots' }, color: '#1f3b73', opacity: 0.8 },
      outline,
    },
  },
]

export const DEMO_VECTOR_STYLE: VectorStyle = {
  components: { kind: 'uv', u: 'u_east', v: 'v_north' },
  color: { kind: 'colormap', field: '_magnitude', colormap: 'plasma' },
  opacity: { kind: 'constant', value: 0.9 },
  size: { min: 0.5, max: 1.4 },
}

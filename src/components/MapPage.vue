<script setup lang="ts">
// The map page. Every dataset is a source layer (table + geometry binding)
// with sublayers, each drawn by the reusable map widgets. The EIA-861
// utilities source is preloaded with its own dashboard and utility search.
import { computed, markRaw, onMounted, ref, shallowRef } from 'vue'
import MapView from './map/MapView.vue'
import ScalarLayer from './map/ScalarLayer'
import VectorLayer from './map/VectorLayer'
import MapLegend from './map/MapLegend.vue'
import FeatureTooltip from './map/FeatureTooltip.vue'
import FeaturePanel from './map/FeaturePanel.vue'
import DataExchange from './map/DataExchange.vue'
import SearchBox from './map/SearchBox.vue'
import AddLayerPanel, { type BuiltInTable, type NewSourceLayer } from './data/AddLayerPanel.vue'
import LayerTree from './data/LayerTree.vue'
import FeatureRows from './data/FeatureRows.vue'
import UtilityCountyDashboard from './UtilityCountyDashboard.vue'
import type { LoadedSource } from './data/types'
import type { HoverInfo } from './map/mapContext'
import { loadBoundaries } from './data/boundaries'
import { UTILITY_BINDING, UTILITY_NAME, UTILITY_TABLE, utilitySublayers, withOwnershipFlags } from './utilityStyles'
import { utilitiesFromRows, utilityRowsFromRecords, type Utility } from '../lib/utilities'
import { MemorySource, StaticFileSource } from '../lib/data/source'
import { inferColumns } from '../lib/layers/columns'
import { buildSource, defaultSublayer, newId, ROW_COUNT, sublayerData, VALUE, U, V, type BuiltSource, type SublayerSpec } from '../lib/layers/sourceLayer'
import { demoVectorRows } from '../lib/demo'
import { focusBox } from '../lib/geometry'
import { colorLegend, MAGNITUDE_FIELD, patternLegend, vectorOf, type LegendEntry } from '../lib/style'
import { fieldLabel, type LayerData, type LayerFeature } from '../lib/schema'
import { formatPrimitive } from '../lib/format'
import { logDebug } from '../debug'

const base = import.meta.env.BASE_URL
const mapView = ref<InstanceType<typeof MapView>>()
const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorMsg = ref('')

const builtIn = new StaticFileSource([UTILITY_TABLE, 'utilities'], base)
const demo = new MemorySource('Demo', { demo_vectors: demoVectorRows() })
const builtIns: BuiltInTable[] = [
  { label: 'EIA-861 utilities by county', source: builtIn, table: UTILITY_TABLE },
  { label: 'EIA-861 utility list (no geometry)', source: builtIn, table: 'utilities' },
  { label: 'Demo vector field (synthetic)', source: demo, table: 'demo_vectors' },
]

// ── source layers ──────────────────────────────────────────────────────────

const sources = ref<LoadedSource[]>([])
const adding = ref(false)
const utilities = shallowRef<Utility[]>([])

async function addSource(
  n: NewSourceLayer,
  opts: { sublayers?: (b: BuiltSource) => SublayerSpec[]; preset?: LoadedSource['preset']; zoom?: boolean } = {},
) {
  const boundaries = n.binding.kind === 'boundary' ? await loadBoundaries(n.binding.boundary) : undefined
  const id = newId('src')
  const built = buildSource({ id, name: n.name, binding: n.binding, source: { label: n.origin } }, n.records, n.columns, boundaries)
  if (built.unmatched) logDebug(`${n.name}: ${built.unmatched} rows had no feature (e.g. ${built.unmatchedSamples.slice(0, 5).join(', ')})`, 'warn')
  sources.value.push({
    spec: { id, name: n.name, binding: n.binding, visible: true, sublayers: opts.sublayers?.(built) ?? [defaultSublayer(built)] },
    built: markRaw(built),
    origin: n.origin,
    preset: opts.preset,
  })
  logDebug(`added "${n.name}": ${built.base.features.length} features from ${n.records.length} rows`)
  if (opts.zoom) zoomTo(id)
}

async function onAdd(n: NewSourceLayer) {
  adding.value = false
  try {
    await addSource(n, { zoom: true })
  } catch (e) {
    logDebug(`could not add "${n.name}": ${(e as Error).message}`, 'error')
  }
}

function removeSource(id: string) {
  sources.value = sources.value.filter((s) => s.spec.id !== id)
  if (selected.value?.sourceId === id) selected.value = null
}

function zoomTo(id: string) {
  const src = sources.value.find((s) => s.spec.id === id)
  const b = src && focusBox(src.built.base.features.filter((f) => (f.properties[ROW_COUNT] as number) > 0).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b, 10)
}

onMounted(async () => {
  try {
    const records = withOwnershipFlags(await builtIn.readTable(UTILITY_TABLE))
    await addSource(
      { name: UTILITY_NAME, origin: 'Built-in · utility_counties.csv (EIA-861, 2025)', records, columns: inferColumns(records), binding: UTILITY_BINDING },
      { sublayers: utilitySublayers, preset: 'utilities' },
    )
    utilities.value = utilitiesFromRows(utilityRowsFromRecords(records))
    status.value = 'ready'
  } catch (e) {
    status.value = 'error'
    errorMsg.value = (e as Error).message
    logDebug(`load failed: ${errorMsg.value}`, 'error')
  }
})

// ── sublayer data (cached: restyling must not rebuild or re-upload data) ────

interface CacheEntry {
  sig: string
  built: BuiltSource
  data: LayerData
  byKey: Map<string, LayerFeature>
}
const cache = new Map<string, CacheEntry>()

function entryFor(src: LoadedSource, sub: SublayerSpec): CacheEntry {
  const what = sub.kind === 'scalar' ? `${sub.column}|${sub.aggregation}` : `${sub.u}|${sub.v}|${sub.aggregation}`
  const sig = `${sub.kind}|${what}|${src.spec.name}|${sub.name}`
  const hit = cache.get(sub.id)
  if (hit && hit.sig === sig && hit.built === src.built) return hit
  const data = markRaw(sublayerData(src.built, src.spec, sub))
  const entry = { sig, built: src.built, data, byKey: new Map(data.features.map((f) => [String(f.id), f])) }
  cache.set(sub.id, entry)
  return entry
}
const dataFor = (src: LoadedSource, sub: SublayerSpec) => entryFor(src, sub).data

const rendered = computed(() =>
  sources.value.flatMap((src) =>
    src.spec.sublayers.map((sub) => ({ src, sub, data: dataFor(src, sub), visible: src.spec.visible && sub.visible })),
  ),
)
const sublayerById = computed(() => new Map(rendered.value.map((r) => [r.data.id, r])))

// ── hover / select ─────────────────────────────────────────────────────────

const canHover = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches
const hover = ref<HoverInfo | null>(null)
const selected = ref<{ sourceId: string; key: string } | null>(null)

function onHover(layerId: string, h: HoverInfo | null) {
  if (!canHover) return
  hover.value = h ? { ...h, layerId } : hover.value?.layerId === layerId ? null : hover.value
}
function onSelect(layerId: string, key: string) {
  const r = sublayerById.value.get(layerId)
  if (r) selected.value = { sourceId: r.src.spec.id, key }
  hover.value = null
}

/** One sublayer's value on a feature, as display text. */
function displayValue(src: LoadedSource, sub: SublayerSpec, key: string): string {
  const { data, byKey } = entryFor(src, sub)
  const p = byKey.get(key)?.properties
  if (!p) return '—'
  if (sub.kind === 'vector') {
    const v = vectorOf(p, { kind: 'uv', u: U, v: V })
    return v ? `${formatPrimitive(v.magnitude, 'double')} toward ${Math.round(v.direction)}°` : '—'
  }
  return formatPrimitive(p[VALUE], data.fields[0].type)
}

const hoverCard = computed(() => {
  const h = hover.value
  const r = h && sublayerById.value.get(h.layerId)
  if (!h || !r) return null
  const f = entryFor(r.src, r.sub).byKey.get(h.featureId)
  if (!f) return null
  const visible = r.src.spec.sublayers.filter((s) => s.visible)
  return {
    x: h.x,
    y: h.y,
    title: String(f.properties._label),
    rows: [
      ...visible.map((s) => ({ label: s.name, value: displayValue(r.src, s, h.featureId) })),
      { label: 'Rows', value: String(f.properties[ROW_COUNT]) },
    ],
  }
})

const selectedFeature = computed(() => {
  const s = selected.value
  const src = s && sources.value.find((x) => x.spec.id === s.sourceId)
  const feature = src?.built.base.features.find((f) => f.id === s!.key)
  return src && feature ? { src, feature, rows: src.built.rowsByKey.get(s!.key) ?? [] } : null
})
const selectedKeyFor = (src: LoadedSource) => (selected.value?.sourceId === src.spec.id ? selected.value.key : null)

// ── utility search (preset extra) ──────────────────────────────────────────

const searchBox = ref<{ clear: () => void }>()
const selectedUtility = ref<Utility | null>(null)
const utilitySource = computed(() => sources.value.find((s) => s.preset === 'utilities'))
const utilityName = (u: Utility) => u.utility_name
const utilityDetail = (u: Utility) => `${u.entity_type} · ${u.states.join(', ')} · ${u.county_fips.length} counties`
function pickUtility(id: number) {
  const u = utilities.value.find((x) => x.utility_id_eia === id) ?? null
  selectedUtility.value = u
  const src = utilitySource.value
  if (!u || !src) return
  const keys = new Set(u.county_fips)
  const b = focusBox(src.built.base.features.filter((f) => keys.has(String(f.id))).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b)
}
function clearUtility() {
  selectedUtility.value = null
  searchBox.value?.clear()
}
const highlightFor = (src: LoadedSource) => (src.preset === 'utilities' ? (selectedUtility.value?.county_fips ?? []) : [])

// ── legend ─────────────────────────────────────────────────────────────────

const legend = computed<LegendEntry[]>(() => {
  const out: LegendEntry[] = []
  const many = sources.value.filter((s) => s.spec.visible).length > 1
  for (const r of rendered.value) {
    if (!r.visible) continue
    const title = many ? `${r.src.spec.name}: ${r.sub.name}` : r.sub.name
    if (r.sub.kind === 'scalar') {
      const e = colorLegend(r.sub.style.color, r.data.features, title)
      if (e) out.push(e)
      const p = r.sub.style.pattern
      if (p.kind === 'field') {
        const fd = r.data.fields.find((f) => f.name === p.field)
        const pe = patternLegend(p, `${title} — pattern${fd && fd.name !== VALUE ? `: ${fieldLabel(fd)}` : ''}`)
        if (pe) out.push(pe)
      }
    } else if (r.sub.style.color.kind !== 'constant') {
      const mags = r.data.features.map((f) => ({ ...f, properties: { [MAGNITUDE_FIELD]: vectorOf(f.properties, { kind: 'uv', u: U, v: V })?.magnitude ?? null } }))
      const e = colorLegend(r.sub.style.color, mags, `${title} (magnitude)`)
      if (e) out.push(e)
    }
  }
  return out
})

// ── export ─────────────────────────────────────────────────────────────────

const exportTarget = ref<string | null>(null)
const exportLayer = computed(() => {
  const src = sources.value.find((s) => s.spec.id === exportTarget.value) ?? sources.value[0]
  return src?.built.base ?? null
})
</script>

<template>
  <div class="page">
    <section class="controls">
      <div v-if="utilitySource" class="search">
        <SearchBox
          ref="searchBox"
          label="Find a utility"
          placeholder="e.g. Duke Energy Carolinas"
          :items="utilities"
          :text="utilityName"
          :detail="utilityDetail"
          @pick="(u) => pickUtility(u.utility_id_eia)"
        />
        <div v-if="selectedUtility" class="chip">
          <div>
            <strong>{{ selectedUtility.utility_name }}</strong>
            <div class="muted">
              {{ selectedUtility.entity_type }} · {{ selectedUtility.county_fips.length }} counties ·
              {{ formatPrimitive(selectedUtility.customers, 'int') }} customers
            </div>
          </div>
          <button aria-label="Clear utility" @click="clearUtility">✕</button>
        </div>
      </div>

      <details class="box" open>
        <summary>Layers</summary>
        <LayerTree :sources="sources" :data-for="dataFor" @remove-source="removeSource" @zoom="zoomTo" />
        <div class="add-wrap">
          <AddLayerPanel v-if="adding" :built-ins="builtIns" @add="onAdd" @cancel="adding = false" />
          <button v-else class="add-btn" @click="adding = true">＋ Add data layer</button>
        </div>
      </details>

      <details class="box">
        <summary>Export (ArcGIS)</summary>
        <label class="row">
          Layer
          <select :value="exportTarget ?? sources[0]?.spec.id" @change="exportTarget = ($event.target as HTMLSelectElement).value">
            <option v-for="s in sources" :key="s.spec.id" :value="s.spec.id">{{ s.spec.name }}</option>
          </select>
        </label>
        <DataExchange :layer="exportLayer" />
        <p class="muted small">
          Source CSVs:
          <a :href="`${base}data/utility_counties.csv`" download>utility_counties.csv</a> ·
          <a :href="`${base}data/utilities.csv`" download>utilities.csv</a>
        </p>
      </details>
    </section>

    <section class="map-wrap">
      <MapView ref="mapView" @background-click="selected = null">
        <template v-for="r in rendered" :key="`${r.data.id}-${r.sub.kind}`">
          <ScalarLayer
            v-if="r.sub.kind === 'scalar'"
            :layer="r.data"
            :style-spec="r.sub.style"
            :visible="r.visible"
            :highlight-ids="highlightFor(r.src)"
            :selected-id="selectedKeyFor(r.src)"
            @hover="(h) => onHover(r.data.id, h)"
            @select="(id) => onSelect(r.data.id, id)"
          />
          <VectorLayer
            v-else
            :layer="r.data"
            :style-spec="r.sub.style"
            :visible="r.visible"
            @hover="(h) => onHover(r.data.id, h)"
            @select="(id) => onSelect(r.data.id, id)"
          />
        </template>
        <template #overlay>
          <div v-if="status !== 'ready'" class="status" :class="status">
            {{ status === 'loading' ? 'Loading data…' : `Couldn't load data: ${errorMsg}` }}
          </div>
          <MapLegend :entries="legend" />
          <FeatureTooltip v-if="hoverCard && !selectedFeature" v-bind="hoverCard" />
          <FeaturePanel v-if="selectedFeature" :layer="selectedFeature.src.built.base" :feature="selectedFeature.feature" @close="selected = null">
            <dl class="values">
              <template v-for="s in selectedFeature.src.spec.sublayers" :key="s.id">
                <dt>{{ s.name }}</dt>
                <dd>{{ displayValue(selectedFeature.src, s, selectedFeature.feature.id as string) }}</dd>
              </template>
            </dl>
            <UtilityCountyDashboard
              v-if="selectedFeature.src.preset === 'utilities'"
              :rows="selectedFeature.rows"
              :selected-utility-id="selectedUtility?.utility_id_eia ?? null"
              @pick-utility="pickUtility"
            />
            <FeatureRows v-else :built="selectedFeature.src.built" :rows="selectedFeature.rows" />
          </FeaturePanel>
        </template>
      </MapView>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: 21rem 1fr;
  gap: 0.75rem;
  height: calc(100dvh - 9rem);
  min-height: 32rem;
}
.controls {
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  font-size: 0.85rem;
  padding-right: 0.15rem;
}
.map-wrap {
  min-height: 0;
}
.chip {
  margin-top: 0.4rem;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--accent-blue);
  border-radius: 0.4rem;
}
.chip button {
  background: none;
  border: none;
  color: var(--text-muted);
}
.box {
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  padding: 0.45rem 0.6rem;
}
.box summary {
  font-weight: 600;
  cursor: pointer;
}
.box[open] summary {
  margin-bottom: 0.45rem;
}
.add-wrap {
  margin-top: 0.6rem;
}
.add-btn {
  width: 100%;
  padding: 0.45rem;
  border: 1px dashed var(--accent-blue);
  border-radius: 0.4rem;
  background: none;
  color: var(--accent-blue);
  font-size: 0.85rem;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}
.row select {
  max-width: 13rem;
  padding: 0.25rem;
}
.muted {
  color: var(--text-muted);
  font-size: 0.78rem;
}
.small {
  font-size: 0.72rem;
}
.values {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 0.6rem;
  margin: 0;
  font-size: 0.82rem;
}
.values dt {
  color: var(--text-muted);
}
.values dd {
  margin: 0;
  font-weight: 600;
}
.status {
  position: absolute;
  z-index: 3;
  top: 0.6rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0.35rem 0.7rem;
  font-size: 0.8rem;
}
.status.error {
  color: var(--danger);
  border-color: var(--danger);
}
@media (max-width: 48rem) {
  .page {
    grid-template-columns: 1fr;
    grid-template-rows: 70dvh auto;
    height: auto;
  }
  .controls {
    order: 2;
    overflow: visible;
  }
  .map-wrap {
    order: 1;
    height: 70dvh;
  }
}
</style>

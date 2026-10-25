<script setup lang="ts">
// The map page. Users import data sources (a table + where its features
// are); each data source gets any number of layers (visualizations of its
// columns), and layers from any mix of data sources show together. The
// EIA-861 utilities data source is preloaded with its own dashboard and
// utility search.
import { computed, markRaw, onMounted, ref, shallowRef } from 'vue'
import MapView from './map/MapView.vue'
import ScalarLayer from './map/ScalarLayer'
import VectorLayer from './map/VectorLayer'
import MapLegend from './map/MapLegend.vue'
import FeatureTooltip from './map/FeatureTooltip.vue'
import FeaturePanel from './map/FeaturePanel.vue'
import DataExchange from './map/DataExchange.vue'
import SearchBox from './map/SearchBox.vue'
import AddDatasourcePanel, { type BuiltInTable, type NewDatasource } from './datasource/AddDatasourcePanel.vue'
import DatasourceList from './datasource/DatasourceList.vue'
import LayerList from './datasource/LayerList.vue'
import FeatureRows from './datasource/FeatureRows.vue'
import UtilityCountyDashboard from './UtilityCountyDashboard.vue'
import type { LoadedDatasource } from './datasource/types'
import type { HoverInfo } from './map/mapContext'
import { loadBoundaries } from './datasource/boundaries'
import { UTILITY_BINDING, UTILITY_NAME, UTILITY_TABLE, utilityLayers, withOwnershipFlags } from './utilityStyles'
import { utilitiesFromRows, utilityRowsFromRecords, type Utility } from '../lib/utilities'
import { MemoryConnector, StaticFileConnector } from '../lib/data/connectors'
import { inferColumns } from '../lib/datasource/columns'
import { buildDatasource, newId, ROW_COUNT, type BuiltDatasource } from '../lib/datasource/datasource'
import { defaultLayer, layerData, makeLayer, ROWS, VALUE, type LayerSpec } from '../lib/datasource/layer'
import { demoVectorRows } from '../lib/demo'
import { focusBox } from '../lib/geometry'
import { colorLegend, MAGNITUDE_FIELD, patternLegend, vectorOf, type LegendEntry } from '../lib/style'
import { fieldLabel, type LayerData, type LayerFeature } from '../lib/schema'
import { formatPrimitive } from '../lib/format'
import { logDebug } from '../debug'

const base = import.meta.env.BASE_URL
const mapView = ref<InstanceType<typeof MapView>>()
const layerList = ref<{ edit: (id: string) => void }>()
const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorMsg = ref('')

const builtIn = new StaticFileConnector([UTILITY_TABLE, 'utilities'], base)
const demo = new MemoryConnector('Demo', { demo_vectors: demoVectorRows() })
const builtIns: BuiltInTable[] = [
  { label: 'EIA-861 utilities by county', connector: builtIn, table: UTILITY_TABLE },
  { label: 'EIA-861 utility list (no geometry)', connector: builtIn, table: 'utilities' },
  { label: 'Demo vector field (synthetic)', connector: demo, table: 'demo_vectors' },
]

// ── data sources and layers ───────────────────────────────────────────────

const datasources = ref<LoadedDatasource[]>([])
const layers = ref<LayerSpec[]>([])
const importing = ref(false)
const utilities = shallowRef<Utility[]>([])

const dsById = computed(() => new Map(datasources.value.map((d) => [d.spec.id, d])))

async function addDatasource(
  n: NewDatasource,
  opts: { layers?: (id: string) => LayerSpec[]; preset?: LoadedDatasource['preset']; zoom?: boolean } = {},
) {
  const boundaries = n.binding.kind === 'boundary' ? await loadBoundaries(n.binding.boundary) : undefined
  const id = newId('ds')
  const built = buildDatasource({ id, name: n.name, binding: n.binding, origin: n.origin }, n.records, n.columns, boundaries)
  if (built.unmatched) logDebug(`${n.name}: ${built.unmatched} rows had no feature (e.g. ${built.unmatchedSamples.slice(0, 5).join(', ')})`, 'warn')
  datasources.value.push({ spec: { id, name: n.name, binding: n.binding, origin: n.origin }, built: markRaw(built), preset: opts.preset })
  layers.value.push(...(opts.layers?.(id) ?? [defaultLayer(built, id)]))
  logDebug(`imported "${n.name}": ${built.base.features.length} features from ${n.records.length} rows`)
  if (opts.zoom) zoomTo(id)
}

async function onImport(n: NewDatasource) {
  importing.value = false
  try {
    await addDatasource(n, { zoom: true })
  } catch (e) {
    logDebug(`could not import "${n.name}": ${(e as Error).message}`, 'error')
  }
}

function removeDatasource(id: string) {
  datasources.value = datasources.value.filter((d) => d.spec.id !== id)
  layers.value = layers.value.filter((l) => l.datasourceId !== id)
  if (selected.value?.datasourceId === id) selected.value = null
}

/** New layer on a data source: its first column not already shown, open for editing. */
function addLayer(datasourceId: string) {
  const ds = dsById.value.get(datasourceId)
  if (!ds) return
  const used = new Set(layers.value.filter((l) => l.datasourceId === datasourceId).map((l) => l.column))
  const column = ds.built.columns.find((c) => !used.has(c.name))?.name ?? ROWS
  const l = makeLayer(ds.built, datasourceId, column)
  layers.value.push(l)
  layerList.value?.edit(l.id)
}

function updateLayer(l: LayerSpec) {
  const i = layers.value.findIndex((x) => x.id === l.id)
  if (i >= 0) layers.value[i] = l
}
function removeLayer(id: string) {
  layers.value = layers.value.filter((l) => l.id !== id)
}

function zoomTo(id: string) {
  const ds = dsById.value.get(id)
  const b = ds && focusBox(ds.built.base.features.filter((f) => (f.properties[ROW_COUNT] as number) > 0).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b, 10)
}

onMounted(async () => {
  try {
    const records = withOwnershipFlags(await builtIn.readTable(UTILITY_TABLE))
    await addDatasource(
      { name: UTILITY_NAME, origin: 'Built-in · utility_counties.csv (EIA-861, 2025)', records, columns: inferColumns(records), binding: UTILITY_BINDING },
      { layers: utilityLayers, preset: 'utilities' },
    )
    utilities.value = utilitiesFromRows(utilityRowsFromRecords(records))
    status.value = 'ready'
  } catch (e) {
    status.value = 'error'
    errorMsg.value = (e as Error).message
    logDebug(`load failed: ${errorMsg.value}`, 'error')
  }
})

// ── layer data (cached: restyling must not rebuild or re-upload data) ──────

interface CacheEntry {
  sig: string
  built: BuiltDatasource
  data: LayerData
  byKey: Map<string, LayerFeature>
}
const cache = new Map<string, CacheEntry>()

function entryFor(l: LayerSpec): CacheEntry | null {
  const ds = dsById.value.get(l.datasourceId)
  if (!ds) return null
  const sig = `${l.column}|${l.aggregation}|${ds.spec.name}|${l.name}`
  const hit = cache.get(l.id)
  if (hit && hit.sig === sig && hit.built === ds.built) return hit
  const data = markRaw(layerData(ds.built, ds.spec.name, l))
  const entry = { sig, built: ds.built, data, byKey: new Map(data.features.map((f) => [String(f.id), f])) }
  cache.set(l.id, entry)
  return entry
}
const dataFor = (l: LayerSpec) => entryFor(l)?.data ?? null

const rendered = computed(() =>
  layers.value.flatMap((l) => {
    const e = entryFor(l)
    const ds = dsById.value.get(l.datasourceId)
    return e && ds ? [{ layer: l, ds, data: e.data }] : []
  }),
)
const renderedById = computed(() => new Map(rendered.value.map((r) => [r.layer.id, r])))

// ── hover / select ─────────────────────────────────────────────────────────

const canHover = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches
const hover = ref<HoverInfo | null>(null)
const selected = ref<{ datasourceId: string; key: string } | null>(null)

function onHover(layerId: string, h: HoverInfo | null) {
  if (!canHover) return
  hover.value = h ? { ...h, layerId } : hover.value?.layerId === layerId ? null : hover.value
}
function onSelect(layerId: string, key: string) {
  const r = renderedById.value.get(layerId)
  if (r) selected.value = { datasourceId: r.ds.spec.id, key }
  hover.value = null
}

/** A layer's value on a feature, as display text. */
function displayValue(l: LayerSpec, key: string): string {
  const e = entryFor(l)
  const p = e?.byKey.get(key)?.properties
  return p ? formatPrimitive(p[VALUE], e!.data.fields[0].type) : '—'
}

/** Layers of a data source, visible ones first. */
const layersOf = (dsId: string, visibleOnly = false) => layers.value.filter((l) => l.datasourceId === dsId && (!visibleOnly || l.visible))

const hoverCard = computed(() => {
  const h = hover.value
  const r = h && renderedById.value.get(h.layerId)
  if (!h || !r) return null
  const f = entryFor(r.layer)?.byKey.get(h.featureId)
  if (!f) return null
  return {
    x: h.x,
    y: h.y,
    title: String(f.properties._label),
    rows: [
      ...layersOf(r.ds.spec.id, true).map((l) => ({ label: l.name, value: displayValue(l, h.featureId) })),
      { label: 'Rows', value: String(f.properties[ROW_COUNT]) },
    ],
  }
})

const selectedFeature = computed(() => {
  const s = selected.value
  const ds = s && dsById.value.get(s.datasourceId)
  const feature = ds?.built.base.features.find((f) => f.id === s!.key)
  return ds && feature ? { ds, feature, key: s!.key, rows: ds.built.rowsByKey.get(s!.key) ?? [] } : null
})
const selectedKeyFor = (dsId: string) => (selected.value?.datasourceId === dsId ? selected.value.key : null)

// ── utility search (preset extra) ──────────────────────────────────────────

const searchBox = ref<{ clear: () => void }>()
const selectedUtility = ref<Utility | null>(null)
const utilityDs = computed(() => datasources.value.find((d) => d.preset === 'utilities'))
const utilityName = (u: Utility) => u.utility_name
const utilityDetail = (u: Utility) => `${u.entity_type} · ${u.states.join(', ')} · ${u.county_fips.length} counties`
function pickUtility(id: number) {
  const u = utilities.value.find((x) => x.utility_id_eia === id) ?? null
  selectedUtility.value = u
  const ds = utilityDs.value
  if (!u || !ds) return
  const keys = new Set(u.county_fips)
  const b = focusBox(ds.built.base.features.filter((f) => keys.has(String(f.id))).map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b)
}
function clearUtility() {
  selectedUtility.value = null
  searchBox.value?.clear()
}
const highlightFor = (ds: LoadedDatasource) => (ds.preset === 'utilities' ? (selectedUtility.value?.county_fips ?? []) : [])

// ── legend ─────────────────────────────────────────────────────────────────

const legend = computed<LegendEntry[]>(() => {
  const out: LegendEntry[] = []
  const shown = rendered.value.filter((r) => r.layer.visible)
  const many = new Set(shown.map((r) => r.ds.spec.id)).size > 1
  for (const { layer: l, ds, data } of shown) {
    const title = many ? `${ds.spec.name}: ${l.name}` : l.name
    if (l.kind === 'scalar') {
      const e = colorLegend(l.style.color, data.features, title)
      if (e) out.push(e)
      const p = l.style.pattern
      if (p.kind === 'field') {
        const fd = data.fields.find((f) => f.name === p.field)
        const pe = patternLegend(p, `${title} — pattern${fd && fd.name !== VALUE ? `: ${fieldLabel(fd)}` : ''}`)
        if (pe) out.push(pe)
      }
    } else if (l.style.color.kind !== 'constant') {
      const mags = data.features.map((f) => ({ ...f, properties: { [MAGNITUDE_FIELD]: vectorOf(f.properties, l.style.components)?.magnitude ?? null } }))
      const e = colorLegend(l.style.color, mags, `${title} (magnitude)`)
      if (e) out.push(e)
    }
  }
  return out
})

// ── export ─────────────────────────────────────────────────────────────────

const exportTarget = ref<string | null>(null)
const exportLayer = computed(() => (dsById.value.get(exportTarget.value ?? '') ?? datasources.value[0])?.built.base ?? null)
</script>

<template>
  <div class="page">
    <section class="controls">
      <div v-if="utilityDs" class="search">
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
        <LayerList ref="layerList" :layers="layers" :datasources="datasources" :data-for="dataFor" @update="updateLayer" @remove="removeLayer" />
      </details>

      <details class="box" open>
        <summary>Data sources</summary>
        <DatasourceList
          :datasources="datasources"
          :layer-count="(id) => layersOf(id).length"
          @add-layer="addLayer"
          @zoom="zoomTo"
          @remove="removeDatasource"
        />
        <div class="import-wrap">
          <AddDatasourcePanel v-if="importing" :built-ins="builtIns" @add="onImport" @cancel="importing = false" />
          <button v-else class="import-btn" @click="importing = true">＋ Import data source</button>
        </div>
      </details>

      <details class="box">
        <summary>Export (ArcGIS)</summary>
        <label class="row">
          Data source
          <select :value="exportTarget ?? datasources[0]?.spec.id" @change="exportTarget = ($event.target as HTMLSelectElement).value">
            <option v-for="d in datasources" :key="d.spec.id" :value="d.spec.id">{{ d.spec.name }}</option>
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
        <template v-for="r in rendered" :key="`${r.layer.id}-${r.layer.kind}`">
          <ScalarLayer
            v-if="r.layer.kind === 'scalar'"
            :layer="r.data"
            :style-spec="r.layer.style"
            :visible="r.layer.visible"
            :highlight-ids="highlightFor(r.ds)"
            :selected-id="selectedKeyFor(r.ds.spec.id)"
            @hover="(h) => onHover(r.layer.id, h)"
            @select="(id) => onSelect(r.layer.id, id)"
          />
          <VectorLayer
            v-else
            :layer="r.data"
            :style-spec="r.layer.style"
            :visible="r.layer.visible"
            @hover="(h) => onHover(r.layer.id, h)"
            @select="(id) => onSelect(r.layer.id, id)"
          />
        </template>
        <template #overlay>
          <div v-if="status !== 'ready'" class="status" :class="status">
            {{ status === 'loading' ? 'Loading data…' : `Couldn't load data: ${errorMsg}` }}
          </div>
          <MapLegend :entries="legend" />
          <FeatureTooltip v-if="hoverCard && !selectedFeature" v-bind="hoverCard" />
          <FeaturePanel v-if="selectedFeature" :layer="selectedFeature.ds.built.base" :feature="selectedFeature.feature" @close="selected = null">
            <dl class="values">
              <template v-for="l in layersOf(selectedFeature.ds.spec.id)" :key="l.id">
                <dt>{{ l.name }}</dt>
                <dd>{{ displayValue(l, selectedFeature.key) }}</dd>
              </template>
            </dl>
            <UtilityCountyDashboard
              v-if="selectedFeature.ds.preset === 'utilities'"
              :rows="selectedFeature.rows"
              :selected-utility-id="selectedUtility?.utility_id_eia ?? null"
              @pick-utility="pickUtility"
            />
            <FeatureRows v-else :built="selectedFeature.ds.built" :rows="selectedFeature.rows" />
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
.import-wrap {
  margin-top: 0.6rem;
}
.import-btn {
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

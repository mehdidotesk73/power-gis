<script setup lang="ts">
// The utilities-by-county map: loads the EIA-861 CSV + county polygons,
// renders them with the reusable map widgets, and wires hover / click /
// utility search / style editing / ArcGIS import-export.
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { feature as topoFeature } from 'topojson-client'
import type { Feature, Geometry } from 'geojson'
import countiesUrl from 'us-atlas/counties-10m.json?url'
import MapView from './map/MapView.vue'
import ScalarLayer from './map/ScalarLayer'
import VectorLayer from './map/VectorLayer'
import MapLegend from './map/MapLegend.vue'
import FeatureTooltip from './map/FeatureTooltip.vue'
import FeaturePanel from './map/FeaturePanel.vue'
import ScalarStyleEditor from './map/ScalarStyleEditor.vue'
import VectorStyleEditor from './map/VectorStyleEditor.vue'
import DataExchange from './map/DataExchange.vue'
import SearchBox from './map/SearchBox.vue'
import UtilityCountyDashboard from './UtilityCountyDashboard.vue'
import type { HoverInfo } from './map/mapContext'
import { DEMO_VECTOR_STYLE, UTILITY_PRESETS } from './utilityStyles'
import { buildCountyLayer, UTILITY_COUNTY_COLUMNS, utilitiesFromRows, utilityRowsFromRecords, type Utility } from '../lib/utilities'
import { LocalFileSource, requireColumns, StaticFileSource, type DataSource } from '../lib/data/source'
import { demoVectorLayer } from '../lib/demo'
import { bboxOf } from '../lib/geometry'
import { colorLegend, patternLegend, type LegendEntry, type ScalarStyle, type VectorStyle } from '../lib/style'
import { fieldLabel, type LayerData, type LayerFeature } from '../lib/schema'
import { formatPrimitive } from '../lib/format'
import { logDebug } from '../debug'

const base = import.meta.env.BASE_URL
const mapView = ref<InstanceType<typeof MapView>>()
const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorMsg = ref('')

const counties = shallowRef<LayerData | null>(null)
const demo = shallowRef<LayerData | null>(null)
const utilities = shallowRef<Utility[]>([])
const imported = ref<{ layer: LayerData; visible: boolean }[]>([])

const presetId = ref(UTILITY_PRESETS[0].id)
const countyStyle = ref<ScalarStyle>(structuredClone(UTILITY_PRESETS[0].style))
watch(presetId, (id) => {
  const p = UTILITY_PRESETS.find((x) => x.id === id)
  if (p) countyStyle.value = structuredClone(p.style)
})
const showCounties = ref(true)
const showDemo = ref(false)
const demoStyle = ref<VectorStyle>(structuredClone(DEMO_VECTOR_STYLE))
const importedStyle: ScalarStyle = {
  color: { kind: 'constant', color: '#7c3aed' },
  opacity: { kind: 'constant', value: 0.6 },
  pattern: { kind: 'none' },
  outline: { color: '#4c1d95', width: 1 },
  size: 5,
}

// ── data source ────────────────────────────────────────────────────────────
// The utility table comes through a DataSource (built-in CSV, a file on the
// device, later a database). County polygons are part of the app either way.

const TABLE = 'utility_counties'
const builtIn = new StaticFileSource([TABLE, 'utilities'], base)
const source = shallowRef<DataSource>(builtIn)
let countyShapes: Promise<Feature<Geometry, { name?: string }>[]> | null = null
const loadCountyShapes = () =>
  (countyShapes ??= fetch(countiesUrl)
    .then((r) => r.json())
    .then((topo) => (topoFeature(topo, topo.objects.counties) as unknown as { features: Feature<Geometry, { name?: string }>[] }).features))

async function load(src: DataSource) {
  status.value = 'loading'
  try {
    const [records, shapes] = await Promise.all([src.readTable(TABLE), loadCountyShapes()])
    requireColumns(records, UTILITY_COUNTY_COLUMNS, TABLE)
    const rows = utilityRowsFromRecords(records)
    const { layer, unmatchedFips } = buildCountyLayer(rows, shapes)
    if (unmatchedFips.length) logDebug(`${unmatchedFips.length} county codes have no polygon: ${unmatchedFips.slice(0, 12).join(', ')}`, 'warn')
    counties.value = layer
    utilities.value = utilitiesFromRows(rows)
    demo.value = demoVectorLayer(layer)
    source.value = src
    selected.value = null
    clearUtility()
    status.value = 'ready'
    logDebug(`loaded ${rows.length} utility-county rows, ${utilities.value.length} utilities from ${src.label}`)
  } catch (e) {
    status.value = 'error'
    errorMsg.value = (e as Error).message
    logDebug(`load failed: ${errorMsg.value}`, 'error')
  }
}
onMounted(() => load(builtIn))

function onLocalFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (f) load(new LocalFileSource([], { [TABLE]: f }))
  input.value = ''
}

// ── feature lookup / hover / select ────────────────────────────────────────

const byId = computed(() => {
  const m = new Map<string, Map<string, LayerFeature>>()
  for (const l of [counties.value, demo.value, ...imported.value.map((i) => i.layer)]) {
    if (l) m.set(l.id, new Map(l.features.map((f) => [String(f.properties[l.idField]), f])))
  }
  return m
})
const layersById = computed(() => {
  const m = new Map<string, LayerData>()
  for (const l of [counties.value, demo.value, ...imported.value.map((i) => i.layer)]) if (l) m.set(l.id, l)
  return m
})
const canHover = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches

const hover = ref<HoverInfo | null>(null)
const selected = ref<{ layerId: string; id: string } | null>(null)
function onHover(layerId: string, h: HoverInfo | null) {
  if (!canHover) return
  hover.value = h ? { ...h, layerId } : hover.value?.layerId === layerId ? null : hover.value
}
function onSelect(layerId: string, id: string) {
  selected.value = { layerId, id }
  hover.value = null
}

const hoverCard = computed(() => {
  const h = hover.value
  if (!h) return null
  const layer = layersById.value.get(h.layerId)
  const f = byId.value.get(h.layerId)?.get(h.featureId)
  if (!layer || !f) return null
  const p = f.properties
  if (layer.id === 'utility-counties') {
    const us = (p.utilities as { utility_name: string }[]) ?? []
    return {
      x: h.x,
      y: h.y,
      title: `${p.county}, ${p.state}`,
      rows: [
        { label: 'Utilities', value: String(p.utility_count) },
        ...us.slice(0, 3).map((u, i) => ({ label: i === 0 ? 'Largest' : '', value: u.utility_name })),
        ...(us.length > 3 ? [{ label: '', value: `+${us.length - 3} more — tap for all` }] : []),
      ],
    }
  }
  const title = String(p[layer.titleField ?? layer.idField] ?? h.featureId)
  const rows = layer.fields
    .filter((fd) => typeof fd.type === 'string' && fd.name !== layer.titleField)
    .slice(0, 5)
    .map((fd) => ({ label: fieldLabel(fd), value: formatPrimitive(p[fd.name], fd.type, fd.unit) }))
  return { x: h.x, y: h.y, title, rows }
})

const selectedFeature = computed(() => {
  const s = selected.value
  if (!s) return null
  const layer = layersById.value.get(s.layerId)
  const feature = byId.value.get(s.layerId)?.get(s.id)
  return layer && feature ? { layer, feature } : null
})
const selectedCountyId = computed(() => (selected.value?.layerId === 'utility-counties' ? selected.value.id : null))

// ── utility search / territory highlight ───────────────────────────────────

const searchBox = ref<{ clear: () => void }>()
const selectedUtility = ref<Utility | null>(null)
const utilityName = (u: Utility) => u.utility_name
const utilityDetail = (u: Utility) => `${u.entity_type} · ${u.states.join(', ')} · ${u.county_fips.length} counties`
function pickUtility(id: number) {
  const u = utilities.value.find((x) => x.utility_id_eia === id) ?? null
  selectedUtility.value = u
  if (!u || !counties.value) return
  const feats = u.county_fips.map((f) => byId.value.get('utility-counties')?.get(f)).filter(Boolean) as LayerFeature[]
  const b = bboxOf(feats.map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b)
}
function clearUtility() {
  selectedUtility.value = null
  searchBox.value?.clear()
}
const highlightIds = computed(() => selectedUtility.value?.county_fips ?? [])

// ── legend ─────────────────────────────────────────────────────────────────

const legend = computed<LegendEntry[]>(() => {
  const out: LegendEntry[] = []
  const c = counties.value
  if (c && showCounties.value) {
    const enc = countyStyle.value.color
    const fd = 'field' in enc ? c.fields.find((f) => f.name === enc.field) : undefined
    const e = colorLegend(enc, c.features, fd ? fieldLabel(fd) : c.name)
    if (e) out.push(e)
    const p = countyStyle.value.pattern
    if (p.kind === 'field') {
      const pf = c.fields.find((f) => f.name === p.field)
      const pe = patternLegend(p, `Pattern: ${pf ? fieldLabel(pf) : p.field}`)
      if (pe) out.push(pe)
    }
  }
  if (demo.value && showDemo.value) {
    const e = colorLegend(demoStyle.value.color, demo.value.features, 'Demo vector magnitude')
    if (e) out.push(e)
  }
  return out
})

const exportTarget = ref<string>('utility-counties')
const exportLayer = computed(() => layersById.value.get(exportTarget.value) ?? null)
function onImported(layer: LayerData) {
  let id = layer.id
  for (let n = 2; layersById.value.has(id); n++) id = `${layer.id}-${n}`
  const l = { ...layer, id }
  imported.value.push({ layer: l, visible: true })
  const b = bboxOf(l.features.map((f) => f.geometry))
  if (b) mapView.value?.fitBounds(b, 10)
}
</script>

<template>
  <div class="page">
    <section class="controls">
      <div class="search">
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

      <details class="box">
        <summary>Data source</summary>
        <p class="muted">Using: <strong>{{ source.label }}</strong></p>
        <div class="src-btns">
          <button :disabled="source === builtIn" @click="load(builtIn)">Built-in (EIA-861 2025)</button>
          <label class="file-btn">
            <input type="file" accept=".csv,text/csv" @change="onLocalFile" />
            CSV on this device…
          </label>
        </div>
        <p class="muted small">
          A CSV needs at least <code>utility_id_eia</code>, <code>utility_name</code> and <code>county_fips</code> columns — same
          layout as the built-in file. It stays on your device.
        </p>
      </details>

      <details class="box" open>
        <summary>Layers</summary>
        <label class="check"><input v-model="showCounties" type="checkbox" /> Utilities by county (EIA-861)</label>
        <label class="row">
          View
          <select v-model="presetId">
            <option v-for="p in UTILITY_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
        </label>
        <label class="check"><input v-model="showDemo" type="checkbox" /> Demo vector arrows (synthetic)</label>
        <label v-for="i in imported" :key="i.layer.id" class="check">
          <input v-model="i.visible" type="checkbox" /> {{ i.layer.name }} <span class="muted">({{ i.layer.features.length }})</span>
        </label>
      </details>

      <details v-if="counties" class="box">
        <summary>Style — counties</summary>
        <ScalarStyleEditor v-model="countyStyle" :layer="counties" />
      </details>
      <details v-if="showDemo" class="box">
        <summary>Style — vector arrows</summary>
        <VectorStyleEditor v-model="demoStyle" />
      </details>
      <details class="box">
        <summary>Import / export (ArcGIS)</summary>
        <label class="row">
          Layer
          <select v-model="exportTarget">
            <option v-for="l in layersById.values()" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </label>
        <DataExchange :layer="exportLayer" @imported="onImported" />
        <p class="muted small">
          Source CSVs:
          <a :href="`${base}data/utility_counties.csv`" download>utility_counties.csv</a> ·
          <a :href="`${base}data/utilities.csv`" download>utilities.csv</a>
        </p>
      </details>
    </section>

    <section class="map-wrap">
      <MapView ref="mapView" @background-click="selected = null">
        <ScalarLayer
          v-if="counties"
          :layer="counties"
          :style-spec="countyStyle"
          :visible="showCounties"
          :highlight-ids="highlightIds"
          :selected-id="selectedCountyId"
          @hover="(h) => onHover('utility-counties', h)"
          @select="(id) => onSelect('utility-counties', id)"
        />
        <ScalarLayer
          v-for="i in imported"
          :key="i.layer.id"
          :layer="i.layer"
          :style-spec="importedStyle"
          :visible="i.visible"
          @hover="(h) => onHover(i.layer.id, h)"
          @select="(id) => onSelect(i.layer.id, id)"
        />
        <VectorLayer
          v-if="demo"
          :layer="demo"
          :style-spec="demoStyle"
          :visible="showDemo"
          @hover="(h) => onHover('demo-vectors', h)"
          @select="(id) => onSelect('demo-vectors', id)"
        />
        <template #overlay>
          <div v-if="status !== 'ready'" class="status" :class="status">
            {{ status === 'loading' ? 'Loading utility data…' : `Couldn't load data: ${errorMsg}` }}
          </div>
          <MapLegend :entries="legend" :source="counties?.source ? `${counties.source.label}, ${counties.source.year}` : undefined" />
          <FeatureTooltip v-if="hoverCard && !selectedFeature" v-bind="hoverCard" />
          <FeaturePanel
            v-if="selectedFeature"
            :layer="selectedFeature.layer"
            :feature="selectedFeature.feature"
            :hide-fields="selectedFeature.layer.id === 'utility-counties' ? ['utilities', 'entity_type_counts'] : []"
            @close="selected = null"
          >
            <template v-if="selectedFeature.layer.id === 'utility-counties'" #title>
              {{ selectedFeature.feature.properties.county }}, {{ selectedFeature.feature.properties.state }}
            </template>
            <template v-if="selectedFeature.layer.id === 'utility-counties'" #default="{ feature }">
              <UtilityCountyDashboard
                :feature="feature"
                :selected-utility-id="selectedUtility?.utility_id_eia ?? null"
                @pick-utility="pickUtility"
              />
            </template>
          </FeaturePanel>
        </template>
      </MapView>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: 19rem 1fr;
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
.box > label {
  margin-bottom: 0.35rem;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.row select {
  max-width: 12rem;
  padding: 0.25rem;
}
.muted {
  color: var(--text-muted);
  font-size: 0.78rem;
}
.small {
  font-size: 0.72rem;
}
.src-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0.3rem 0;
}
.src-btns button,
.file-btn {
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.8rem;
  cursor: pointer;
}
.file-btn input {
  display: none;
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

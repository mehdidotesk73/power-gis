<script setup lang="ts">
// Import / export for ArcGIS round trips.
//   Export: GeoJSON, GeoJSON flattened for ArcGIS Online, Esri JSON
//           FeatureSet, attribute CSV (join on the id field).
//   Import: a .geojson / Esri .json file, or an ArcGIS REST layer URL.
import { ref } from 'vue'
import { fetchArcGISLayer, importJSON, toCSV, toEsriFeatureSet, toGeoJSON } from '../../lib/arcgis'
import type { LayerData } from '../../lib/schema'
import { logDebug } from '../../debug'

const props = defineProps<{ layer: LayerData | null }>()
const emit = defineEmits<{ (e: 'imported', layer: LayerData): void }>()

const url = ref('')
const busy = ref(false)
const error = ref('')

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function exportAs(kind: 'geojson' | 'agol' | 'esri' | 'csv') {
  const l = props.layer
  if (!l) return
  if (kind === 'geojson') download(`${l.id}.geojson`, JSON.stringify(toGeoJSON(l)), 'application/geo+json')
  else if (kind === 'agol') download(`${l.id}-arcgis.geojson`, JSON.stringify(toGeoJSON(l, true)), 'application/geo+json')
  else if (kind === 'esri') download(`${l.id}.esri.json`, JSON.stringify(toEsriFeatureSet(l)), 'application/json')
  else download(`${l.id}.csv`, toCSV(l), 'text/csv')
}

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = ''
  try {
    const layer = importJSON(JSON.parse(await file.text()), file.name.replace(/\.(geo)?json$/i, ''))
    logDebug(`imported ${layer.features.length} features from ${file.name}`)
    emit('imported', layer)
  } catch (err) {
    error.value = (err as Error).message
  }
  ;(e.target as HTMLInputElement).value = ''
}

async function onUrl() {
  if (!url.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const layer = await fetchArcGISLayer(url.value.trim(), { maxFeatures: 5000 })
    logDebug(`loaded ${layer.features.length} features from ArcGIS`)
    emit('imported', layer)
  } catch (err) {
    error.value = `Could not load that layer: ${(err as Error).message}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="io">
    <div class="group">
      <div class="label">Export {{ layer ? `“${layer.name}”` : '' }}</div>
      <div class="btns">
        <button :disabled="!layer" @click="exportAs('geojson')">GeoJSON</button>
        <button :disabled="!layer" @click="exportAs('agol')" title="Nested values flattened to JSON text — for ArcGIS Online's GeoJSON import">GeoJSON (ArcGIS Online)</button>
        <button :disabled="!layer" @click="exportAs('esri')" title="Esri FeatureSet JSON (WGS84)">Esri JSON</button>
        <button :disabled="!layer" @click="exportAs('csv')" title="Attributes only — join to geometry on the id field">CSV</button>
      </div>
    </div>
    <div class="group">
      <div class="label">Import a layer</div>
      <label class="file">
        <input type="file" accept=".json,.geojson,application/json,application/geo+json" @change="onFile" />
        GeoJSON or Esri JSON file…
      </label>
      <form class="url" @submit.prevent="onUrl">
        <input v-model="url" type="url" placeholder="https://…/FeatureServer/0" inputmode="url" autocapitalize="off" />
        <button type="submit" :disabled="busy">{{ busy ? 'Loading…' : 'Load' }}</button>
      </form>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.io {
  display: grid;
  gap: 0.75rem;
  font-size: 0.82rem;
}
.label {
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.btns {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
button,
.file {
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.78rem;
}
.file {
  display: inline-block;
  cursor: pointer;
  margin-bottom: 0.4rem;
}
.file input {
  display: none;
}
.url {
  display: flex;
  gap: 0.35rem;
}
.url input {
  flex: 1;
  min-width: 0;
  padding: 0.35rem;
  font-size: 0.85rem;
}
.error {
  color: var(--danger);
  margin: 0.3rem 0 0;
}
</style>

<script setup lang="ts">
// Export for ArcGIS round trips: GeoJSON, GeoJSON flattened for ArcGIS
// Online, Esri JSON FeatureSet, attribute CSV (join on the id field).
// (Importing is done by adding a data layer — see data/AddLayerPanel.vue.)
import { toCSV, toEsriFeatureSet, toGeoJSON } from '../../lib/arcgis'
import type { LayerData } from '../../lib/schema'

const props = defineProps<{ layer: LayerData | null }>()

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

<script setup lang="ts">
// Export for ArcGIS round trips: GeoJSON, GeoJSON flattened for ArcGIS
// Online, Esri JSON FeatureSet, attribute CSV (join on the id field). The
// server builds the file (exportVisualization); this only downloads it.
// (Importing is done by adding a dataset.)
import { ref } from 'vue'
import { request } from '../../client/api'
import { saveFile } from '../../client/saveFile'
import type { VisualizationSpec } from '../../lib/dataset/visualization'

const props = defineProps<{ visualization: VisualizationSpec | null }>()
const busy = ref(false)
const error = ref('')


async function exportAs(format: 'geojson' | 'agol' | 'esri' | 'csv') {
  const v = props.visualization
  if (!v || busy.value) return
  busy.value = true
  error.value = ''
  const { id, name, datasetId, binding, column, aggregation } = v
  const r = await request('exportVisualization', { visualization: { id, name, datasetId, binding, column, aggregation }, format })
  busy.value = false
  if (r.ok) await saveFile(new Blob([r.data.text], { type: r.data.mimeType }), r.data.fileName)
  else error.value = r.error.message
}
</script>

<template>
  <div class="io">
    <div class="group">
      <div class="label">Export {{ visualization ? `“${visualization.name}”` : '' }}</div>
      <div class="btns">
        <button :disabled="!visualization || busy" @click="exportAs('geojson')">GeoJSON</button>
        <button :disabled="!visualization || busy" @click="exportAs('agol')" title="Nested values flattened to JSON text — for ArcGIS Online's GeoJSON import">GeoJSON (ArcGIS Online)</button>
        <button :disabled="!visualization || busy" @click="exportAs('esri')" title="Esri FeatureSet JSON (WGS84)">Esri JSON</button>
        <button :disabled="!visualization || busy" @click="exportAs('csv')" title="Attributes only — join to geometry on the id field">CSV</button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.error {
  color: var(--danger);
  margin: 0.35rem 0 0;
}
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

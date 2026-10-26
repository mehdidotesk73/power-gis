<script setup lang="ts">
// Edits one visualization: where its features come from (binding), which
// column it shows, how rows combine per feature, and its style. Arrows or
// scalar follow from the column's type.
import { computed } from 'vue'
import ScalarStyleEditor from '../map/ScalarStyleEditor.vue'
import VectorStyleEditor from '../map/VectorStyleEditor.vue'
import BindingEditor from './BindingEditor.vue'
import { useBindingInfo } from './useBindingInfo'
import { AGGREGATIONS, aggregationsFor, type Aggregation } from '../../lib/dataset/aggregate'
import { bindingColumns, type GeometryBinding } from '../../lib/dataset/binding'
import { columnType, dataColumns, retarget, ROWS, type VisualizationSpec } from '../../lib/dataset/visualization'
import type { DatasetRecord } from '../../shared/records'
import type { LayerData } from '../../lib/schema'

const props = defineProps<{ dataset: DatasetRecord; layer: VisualizationSpec; data: LayerData | null }>()
const emit = defineEmits<{ (e: 'update', l: VisualizationSpec): void; (e: 'remove'): void }>()

const { info, error } = useBindingInfo(
  () => props.dataset.id,
  () => props.layer.binding,
)
const columns = computed(() => dataColumns(props.dataset.columns, props.layer.binding))
const aggregations = computed<Aggregation[]>(() => (props.layer.column === ROWS ? ['count'] : aggregationsFor(columnType(columns.value, props.layer.column))))

function setColumn(column: string, aggregation: Aggregation) {
  const shape = info.value ?? { columns: columns.value, maxRowsPerFeature: 1, geometryKind: 'region' as const }
  const allowed = column === ROWS ? ['count'] : aggregationsFor(columnType(columns.value, column))
  emit('update', retarget(shape, props.layer, column, allowed.includes(aggregation) ? aggregation : (allowed[0] as Aggregation)))
}
function setBinding(binding: GeometryBinding) {
  // A column the new binding consumes can't also be the value.
  const clash = bindingColumns(binding).includes(props.layer.column)
  emit('update', { ...props.layer, binding, ...(clash ? { column: ROWS, aggregation: 'count' as const } : {}) } as VisualizationSpec)
}
</script>

<template>
  <div class="ed">
    <label class="row">Name <input :value="layer.name" type="text" @change="emit('update', { ...layer, name: ($event.target as HTMLInputElement).value })" /></label>
    <details class="where">
      <summary>Features: {{ info ? `${info.features.toLocaleString()} ${info.geometryKind === 'point' ? 'points' : info.geometryKind === 'polyline' ? 'lines' : 'regions'}` : '…' }}</summary>
      <BindingEditor :columns="dataset.columns" :model-value="layer.binding" :info="info" :error="error" @update:model-value="setBinding" />
    </details>
    <label class="row">
      Value to show
      <select :value="layer.column" @change="setColumn(($event.target as HTMLSelectElement).value, layer.aggregation)">
        <option :value="ROWS">Number of rows</option>
        <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }})</option>
      </select>
    </label>
    <label class="row">
      Per feature
      <select :value="layer.aggregation" @change="setColumn(layer.column, ($event.target as HTMLSelectElement).value as Aggregation)">
        <option v-for="a in aggregations" :key="a" :value="a">{{ AGGREGATIONS[a] }}</option>
      </select>
    </label>
    <p class="muted">{{ layer.kind === 'vector' ? 'Vector values — drawn as arrows.' : 'Scalar values — drawn with color, transparency and pattern.' }}</p>
    <template v-if="data">
      <ScalarStyleEditor v-if="layer.kind === 'scalar'" :model-value="layer.style" :layer="data" @update:model-value="(style) => emit('update', { ...layer, style } as VisualizationSpec)" />
      <VectorStyleEditor v-else :model-value="layer.style" @update:model-value="(style) => emit('update', { ...layer, style } as VisualizationSpec)" />
    </template>
    <p v-else class="muted">Loading values…</p>
    <button class="remove" @click="emit('remove')">Remove visualization</button>
  </div>
</template>

<style scoped>
.ed {
  display: grid;
  gap: 0.45rem;
  font-size: 0.82rem;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.row select,
.row input {
  min-width: 0;
  flex: 1;
  max-width: 13rem;
  padding: 0.3rem;
  font-size: 0.85rem;
}
.muted {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.74rem;
}
.where summary {
  font-size: 0.78rem;
  color: var(--text-muted);
}
.where[open] summary {
  margin-bottom: 0.35rem;
}
.remove {
  justify-self: start;
  background: none;
  border: none;
  color: var(--danger);
  font-size: 0.78rem;
  padding: 0;
}
</style>

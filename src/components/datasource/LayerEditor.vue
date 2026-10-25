<script setup lang="ts">
// Edits one layer: which column it shows, how rows combine per feature, and
// its style. Arrows or scalar follow from the column's type.
import { computed } from 'vue'
import ScalarStyleEditor from '../map/ScalarStyleEditor.vue'
import VectorStyleEditor from '../map/VectorStyleEditor.vue'
import { AGGREGATIONS, aggregationsFor, type Aggregation } from '../../lib/datasource/aggregate'
import { columnType, retarget, ROWS, type LayerSpec } from '../../lib/datasource/layer'
import type { BuiltDatasource } from '../../lib/datasource/datasource'
import type { LayerData } from '../../lib/schema'

const props = defineProps<{ built: BuiltDatasource; layer: LayerSpec; data: LayerData }>()
const emit = defineEmits<{ (e: 'update', l: LayerSpec): void; (e: 'remove'): void }>()

const aggregations = computed<Aggregation[]>(() => (props.layer.column === ROWS ? ['count'] : aggregationsFor(columnType(props.built, props.layer.column))))

function setColumn(column: string, aggregation: Aggregation) {
  const allowed = column === ROWS ? ['count'] : aggregationsFor(columnType(props.built, column))
  emit('update', retarget(props.built, props.layer, column, allowed.includes(aggregation) ? aggregation : (allowed[0] as Aggregation)))
}
</script>

<template>
  <div class="ed">
    <label class="row">Name <input :value="layer.name" type="text" @change="emit('update', { ...layer, name: ($event.target as HTMLInputElement).value })" /></label>
    <label class="row">
      Column
      <select :value="layer.column" @change="setColumn(($event.target as HTMLSelectElement).value, layer.aggregation)">
        <option :value="ROWS">Number of rows</option>
        <option v-for="c in built.columns" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }})</option>
      </select>
    </label>
    <label class="row">
      Per feature
      <select :value="layer.aggregation" @change="setColumn(layer.column, ($event.target as HTMLSelectElement).value as Aggregation)">
        <option v-for="a in aggregations" :key="a" :value="a">{{ AGGREGATIONS[a] }}</option>
      </select>
    </label>
    <p class="muted">{{ layer.kind === 'vector' ? 'Vector values — drawn as arrows.' : 'Scalar values — drawn with color, transparency and pattern.' }}</p>
    <ScalarStyleEditor v-if="layer.kind === 'scalar'" :model-value="layer.style" :layer="data" @update:model-value="(style) => emit('update', { ...layer, style } as LayerSpec)" />
    <VectorStyleEditor v-else :model-value="layer.style" @update:model-value="(style) => emit('update', { ...layer, style } as LayerSpec)" />
    <button class="remove" @click="emit('remove')">Remove layer</button>
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
.remove {
  justify-self: start;
  background: none;
  border: none;
  color: var(--danger);
  font-size: 0.78rem;
  padding: 0;
}
</style>

<script setup lang="ts">
// Where a visualization draws: a geometry column (points, polylines or
// regions), plus an optional column that names each feature. Region codes
// (FIPS, state names) are joined onto a boundary dataset in a transform
// first. Shows the server's answer for how many rows matched.
import { computed } from 'vue'
import { geometryColumns, type GeometryBinding } from '../../lib/dataset/binding'
import type { ColumnInfo } from '../../lib/dataset/columns'
import type { BindingInfo } from '../../lib/dataset/query'

const props = defineProps<{ columns: ColumnInfo[]; modelValue: GeometryBinding; info: BindingInfo | null; error?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', b: GeometryBinding): void }>()

const geoms = computed(() => geometryColumns(props.columns))
const labels = computed(() => props.columns.filter((c) => c.type === 'string' || c.type === 'int'))
const value = (e: Event) => (e.target as HTMLSelectElement).value
function setLabel(label: string) {
  const { label: _old, ...rest } = props.modelValue
  emit('update:modelValue', label ? { ...rest, label } : rest)
}
</script>

<template>
  <div class="binding">
    <div class="lbl">Draw on</div>
    <template v-if="geoms.length">
      <label class="row">
        Geometry
        <select :value="modelValue.column" @change="emit('update:modelValue', { ...modelValue, column: value($event) })">
          <option v-for="c in geoms" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }})</option>
        </select>
      </label>
      <label class="row">
        Feature names
        <select :value="modelValue.label ?? ''" @change="setLabel(value($event))">
          <option value="">(none)</option>
          <option v-for="c in labels" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>
    </template>
    <p v-else class="small muted">
      This dataset has no geometry column, so it can't be drawn. Make one with a transform: <code>point(lat, lon)</code> for coordinates, or a join onto
      a boundary dataset (＋ Add dataset → Built-in → US counties / US states) for region codes.
    </p>
    <p v-if="error" class="small bad">{{ error }}</p>
    <p v-else-if="info" class="small" :class="info.features ? 'ok' : 'bad'">
      {{ info.features.toLocaleString() }} features from {{ info.matchedRows.toLocaleString() }} rows
      <template v-if="info.unmatched"> · {{ info.unmatched.toLocaleString() }} rows without one (e.g. {{ info.unmatchedSamples.slice(0, 3).join(', ') }})</template>
    </p>
    <p v-else-if="modelValue.column" class="small muted">Checking…</p>
  </div>
</template>

<style scoped>
.binding {
  display: grid;
  gap: 0.4rem;
}
.lbl {
  font-weight: 600;
  font-size: 0.78rem;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.row select {
  min-width: 0;
  flex: 1;
  max-width: 13rem;
  padding: 0.3rem;
  font-size: 0.85rem;
}
.small {
  margin: 0;
  font-size: 0.74rem;
}
.muted {
  color: var(--text-muted);
}
.ok {
  color: #2e7d32;
}
.bad {
  color: var(--danger);
}
</style>

<script setup lang="ts">
// Where a visualization draws: a geometry column (points, polylines or
// regions) — or, until transforms can join a boundary dataset, a column of
// region codes matched to built-in county / state polygons. Shows the
// server's answer for how many rows matched.
import { computed } from 'vue'
import { BOUNDARIES, geometryColumns, type GeometryBinding } from '../../lib/dataset/binding'
import type { ColumnInfo } from '../../lib/dataset/columns'
import type { BindingInfo } from '../../lib/dataset/query'

const props = defineProps<{ columns: ColumnInfo[]; modelValue: GeometryBinding; info: BindingInfo | null; error?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', b: GeometryBinding): void }>()

const geoms = computed(() => geometryColumns(props.columns))
const codes = computed(() => props.columns.filter((c) => c.type === 'string' || c.type === 'int'))
const set = (patch: Partial<GeometryBinding>) => emit('update:modelValue', { ...props.modelValue, ...patch } as GeometryBinding)

function setKind(kind: GeometryBinding['kind']) {
  if (kind === 'geometry') emit('update:modelValue', { kind, column: geoms.value[0]?.name ?? '' })
  else emit('update:modelValue', { kind, column: codes.value[0]?.name ?? props.columns[0]?.name ?? '', boundary: 'us-counties' })
}
const value = (e: Event) => (e.target as HTMLSelectElement).value
</script>

<template>
  <div class="binding">
    <div class="lbl">Draw on</div>
    <div class="seg">
      <button :class="{ on: modelValue.kind === 'geometry' }" @click="setKind('geometry')">Geometry column</button>
      <button :class="{ on: modelValue.kind === 'boundary' }" @click="setKind('boundary')">Region code</button>
    </div>
    <template v-if="modelValue.kind === 'geometry'">
      <label v-if="geoms.length" class="row">
        Column
        <select :value="modelValue.column" @change="set({ column: value($event) })">
          <option v-for="c in geoms" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }})</option>
        </select>
      </label>
      <p v-else class="small muted">
        This dataset has no geometry column, so it can't be drawn yet. Latitude and longitude columns will be turnable into points with a transform.
      </p>
    </template>
    <template v-else>
      <label class="row">
        Code column
        <select :value="modelValue.column" @change="set({ column: value($event) })">
          <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>
      <label class="row">
        Regions
        <select :value="modelValue.boundary" @change="set({ boundary: value($event) as never })">
          <option v-for="(label, id) in BOUNDARIES" :key="id" :value="id">{{ label }}</option>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" :checked="!!modelValue.includeEmpty" @change="set({ includeEmpty: ($event.target as HTMLInputElement).checked })" />
        Also show regions with no rows
      </label>
      <p class="small muted">Built-in county / state shapes — a stopgap until a boundary dataset can be joined in.</p>
    </template>
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
.seg {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.seg button {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.76rem;
}
.seg button.on {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
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
.check {
  display: flex;
  gap: 0.35rem;
  align-items: center;
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

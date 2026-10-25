<script setup lang="ts">
// Where each row's feature comes from: a region-code column, lat/lon
// columns, or a geometry column — part of a visualization's settings. Shows
// the server's answer for how many rows matched.
import { BOUNDARIES, guessBinding, type GeometryBinding } from '../../lib/dataset/binding'
import type { ColumnInfo } from '../../lib/dataset/columns'
import type { BindingInfo } from '../../lib/dataset/query'

const props = defineProps<{ columns: ColumnInfo[]; modelValue: GeometryBinding; info: BindingInfo | null; error?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', b: GeometryBinding): void }>()

const set = (patch: Partial<GeometryBinding>) => emit('update:modelValue', { ...props.modelValue, ...patch } as GeometryBinding)

function setKind(kind: GeometryBinding['kind']) {
  const first = props.columns[0]?.name ?? ''
  const guess = guessBinding(props.columns)
  if (guess?.kind === kind) emit('update:modelValue', guess)
  else if (kind === 'boundary') emit('update:modelValue', { kind, column: first, boundary: 'us-counties' })
  else if (kind === 'latlon') emit('update:modelValue', { kind, lat: first, lon: props.columns[1]?.name ?? first })
  else emit('update:modelValue', { kind, column: first })
}
const value = (e: Event) => (e.target as HTMLSelectElement).value
</script>

<template>
  <div class="binding">
    <div class="lbl">Each row's feature comes from</div>
    <div class="seg">
      <button :class="{ on: modelValue.kind === 'boundary' }" @click="setKind('boundary')">Region code</button>
      <button :class="{ on: modelValue.kind === 'latlon' }" @click="setKind('latlon')">Lat / lon</button>
      <button :class="{ on: modelValue.kind === 'geometry' }" @click="setKind('geometry')">Geometry column</button>
    </div>
    <template v-if="modelValue.kind === 'boundary'">
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
    </template>
    <template v-else-if="modelValue.kind === 'latlon'">
      <label class="row">
        Latitude
        <select :value="modelValue.lat" @change="set({ lat: value($event) })">
          <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>
      <label class="row">
        Longitude
        <select :value="modelValue.lon" @change="set({ lon: value($event) })">
          <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>
    </template>
    <label v-else class="row">
      GeoJSON / WKT column
      <select :value="modelValue.column" @change="set({ column: value($event) })">
        <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
      </select>
    </label>
    <p v-if="error" class="small bad">{{ error }}</p>
    <p v-else-if="info" class="small" :class="info.features ? 'ok' : 'bad'">
      {{ info.features.toLocaleString() }} features from {{ info.matchedRows.toLocaleString() }} rows
      <template v-if="info.unmatched"> · {{ info.unmatched.toLocaleString() }} rows unmatched (e.g. {{ info.unmatchedSamples.slice(0, 3).join(', ') }})</template>
    </p>
    <p v-else class="small muted">Checking…</p>
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

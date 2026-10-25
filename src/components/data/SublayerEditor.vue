<script setup lang="ts">
// Edits one sublayer in place: what it shows (column + aggregation, or two
// vector components) and how (scalar or vector style).
import { computed } from 'vue'
import ScalarStyleEditor from '../map/ScalarStyleEditor.vue'
import VectorStyleEditor from '../map/VectorStyleEditor.vue'
import { AGGREGATIONS, aggregationsFor, type Aggregation } from '../../lib/layers/aggregate'
import { isNumericColumn } from '../../lib/layers/columns'
import {
  columnLabel,
  defaultScalarStyle,
  defaultVectorStyle,
  ROWS,
  valueType,
  type BuiltSource,
  type SublayerSpec,
} from '../../lib/layers/sourceLayer'
import type { LayerData } from '../../lib/schema'

const props = defineProps<{ built: BuiltSource; sub: SublayerSpec; data: LayerData }>()
const emit = defineEmits<{ (e: 'update', s: SublayerSpec): void; (e: 'remove'): void }>()

const numeric = computed(() => props.built.columns.filter((c) => isNumericColumn(c.type)))
const columnType = (name: string) => (name === ROWS ? 'int' : (props.built.columns.find((c) => c.name === name)?.type ?? 'string'))
const aggregations = computed<Aggregation[]>(() => {
  if (props.sub.kind === 'vector') return ['mean', 'sum', 'first', 'min', 'max']
  return props.sub.column === ROWS ? ['count'] : aggregationsFor(columnType(props.sub.column))
})

function update(patch: Partial<SublayerSpec>) {
  emit('update', { ...props.sub, ...patch } as SublayerSpec)
}

/** Changing what's shown can change the value's type; restyle only when the kind of value changes. */
function setScalar(column: string, aggregation?: Aggregation) {
  if (props.sub.kind !== 'scalar') return
  const allowed = column === ROWS ? ['count'] : aggregationsFor(columnType(column))
  const agg = aggregation && allowed.includes(aggregation) ? aggregation : (allowed[0] as Aggregation)
  const before = isNumericColumn(valueType(props.built, props.sub.column, props.sub.aggregation))
  const after = isNumericColumn(valueType(props.built, column, agg))
  const renamed = props.sub.name === columnLabel(props.sub.column) ? columnLabel(column) : props.sub.name
  update({
    column,
    aggregation: agg,
    name: renamed,
    ...(before !== after ? { style: defaultScalarStyle(valueType(props.built, column, agg), props.built.geometryKind) } : {}),
  })
}

function setKind(kind: 'scalar' | 'vector') {
  if (kind === props.sub.kind) return
  // Keep a name the user typed; replace one that was just the default.
  const auto = props.sub.kind === 'scalar' ? props.sub.name === columnLabel(props.sub.column) : props.sub.name === `${columnLabel(props.sub.u)} / ${columnLabel(props.sub.v)}`
  const base = { id: props.sub.id, name: props.sub.name, visible: props.sub.visible }
  if (kind === 'vector') {
    const [u, v] = [numeric.value[0]?.name ?? '', numeric.value[1]?.name ?? numeric.value[0]?.name ?? '']
    if (auto) base.name = `${columnLabel(u)} / ${columnLabel(v)}`
    emit('update', { ...base, kind, u, v, aggregation: props.built.maxRowsPerFeature > 1 ? 'mean' : 'first', style: defaultVectorStyle() })
  } else {
    if (auto) base.name = columnLabel(ROWS)
    emit('update', { ...base, kind, column: ROWS, aggregation: 'count', style: defaultScalarStyle('int', props.built.geometryKind) })
  }
}
</script>

<template>
  <div class="ed">
    <label class="row">Name <input :value="sub.name" type="text" @change="update({ name: ($event.target as HTMLInputElement).value })" /></label>
    <div class="seg">
      <button :class="{ on: sub.kind === 'scalar' }" @click="setKind('scalar')">Scalar</button>
      <button :class="{ on: sub.kind === 'vector' }" :disabled="numeric.length === 0" @click="setKind('vector')">Vector (arrows)</button>
    </div>

    <template v-if="sub.kind === 'scalar'">
      <label class="row">
        Column
        <select :value="sub.column" @change="setScalar(($event.target as HTMLSelectElement).value, sub.aggregation)">
          <option :value="ROWS">Number of rows</option>
          <option v-for="c in built.columns" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }})</option>
        </select>
      </label>
      <label class="row">
        Per feature
        <select :value="sub.aggregation" @change="setScalar(sub.column, ($event.target as HTMLSelectElement).value as Aggregation)">
          <option v-for="a in aggregations" :key="a" :value="a">{{ AGGREGATIONS[a] }}</option>
        </select>
      </label>
      <ScalarStyleEditor :model-value="sub.style" :layer="data" @update:model-value="(style) => update({ style })" />
    </template>

    <template v-else>
      <label class="row">
        East (u)
        <select :value="sub.u" @change="update({ u: ($event.target as HTMLSelectElement).value })">
          <option v-for="c in numeric" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>
      <label class="row">
        North (v)
        <select :value="sub.v" @change="update({ v: ($event.target as HTMLSelectElement).value })">
          <option v-for="c in numeric" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>
      <label class="row">
        Per feature
        <select :value="sub.aggregation" @change="update({ aggregation: ($event.target as HTMLSelectElement).value as Aggregation })">
          <option v-for="a in aggregations" :key="a" :value="a">{{ AGGREGATIONS[a] }}</option>
        </select>
      </label>
      <VectorStyleEditor :model-value="sub.style" @update:model-value="(style) => update({ style })" />
    </template>

    <button class="remove" @click="emit('remove')">Remove sublayer</button>
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
.seg {
  display: flex;
}
.seg button {
  flex: 1;
  padding: 0.35rem;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.78rem;
}
.seg button + button {
  border-left: none;
}
.seg button:first-child {
  border-radius: 0.35rem 0 0 0.35rem;
}
.seg button:last-child {
  border-radius: 0 0.35rem 0.35rem 0;
}
.seg button.on {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: #fff;
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

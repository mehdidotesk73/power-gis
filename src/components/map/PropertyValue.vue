<script setup lang="ts">
// Renders any typed value: primitives formatted, lists of structs as tables,
// other lists as chips, dicts and structs as nested key/value rows.
import { computed } from 'vue'
import { fieldLabel, isPrimitive, type FieldDef, type FieldType } from '../../lib/schema'
import { formatPrimitive } from '../../lib/format'

const props = defineProps<{ value: unknown; type: FieldType; unit?: string; depth?: number }>()
const depth = computed(() => props.depth ?? 0)

const structList = computed(() => {
  const t = props.type
  if (isPrimitive(t) || t.kind !== 'list' || isPrimitive(t.of) || t.of.kind !== 'struct') return null
  return { fields: t.of.fields, rows: Array.isArray(props.value) ? (props.value as Record<string, unknown>[]) : [] }
})
const list = computed(() => {
  const t = props.type
  if (isPrimitive(t) || t.kind !== 'list' || structList.value) return null
  return { of: t.of, items: Array.isArray(props.value) ? props.value : [] }
})
const entries = computed<{ key: string; type: FieldType; value: unknown }[] | null>(() => {
  const t = props.type
  if (isPrimitive(t) || t.kind === 'list') return null
  const v = (props.value ?? {}) as Record<string, unknown>
  if (t.kind === 'dict') return Object.entries(v).map(([key, value]) => ({ key, type: t.of, value }))
  return t.fields.map((f: FieldDef) => ({ key: fieldLabel(f), type: f.type, value: v[f.name] }))
})
const MAX_ROWS = 50
</script>

<template>
  <span v-if="isPrimitive(type)" class="pv-prim">{{ formatPrimitive(value, type, unit) }}</span>

  <div v-else-if="structList" class="pv-table-wrap">
    <span v-if="!structList.rows.length" class="muted">none</span>
    <table v-else class="pv-table">
      <thead>
        <tr>
          <th v-for="f in structList.fields" :key="f.name">{{ fieldLabel(f) }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in structList.rows.slice(0, MAX_ROWS)" :key="i">
          <td v-for="f in structList.fields" :key="f.name">
            <PropertyValue :value="row[f.name]" :type="f.type" :unit="f.unit" :depth="depth + 1" />
          </td>
        </tr>
      </tbody>
    </table>
    <span v-if="structList.rows.length > MAX_ROWS" class="muted">+{{ structList.rows.length - MAX_ROWS }} more</span>
  </div>

  <span v-else-if="list" class="pv-chips">
    <span v-if="!list.items.length" class="muted">none</span>
    <span v-for="(item, i) in list.items.slice(0, MAX_ROWS)" :key="i" class="pv-chip">
      <PropertyValue :value="item" :type="list.of" :depth="depth + 1" />
    </span>
  </span>

  <dl v-else-if="entries" class="pv-kv" :class="{ nested: depth > 0 }">
    <template v-for="e in entries" :key="e.key">
      <dt>{{ e.key }}</dt>
      <dd><PropertyValue :value="e.value" :type="e.type" :depth="depth + 1" /></dd>
    </template>
  </dl>
</template>

<style scoped>
.pv-table-wrap {
  overflow-x: auto;
  max-width: 100%;
}
.pv-table {
  border-collapse: collapse;
  font-size: 0.78rem;
  width: 100%;
}
.pv-table th,
.pv-table td {
  text-align: left;
  padding: 0.2rem 0.4rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.pv-table th {
  color: var(--text-muted);
  font-weight: 600;
  white-space: nowrap;
}
.pv-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.pv-chip {
  background: var(--bg-elev-2);
  border-radius: 0.3rem;
  padding: 0 0.35rem;
  font-size: 0.8rem;
}
.pv-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.15rem 0.6rem;
  margin: 0;
  font-size: 0.82rem;
}
.pv-kv dt {
  color: var(--text-muted);
}
.pv-kv dd {
  margin: 0;
  min-width: 0;
}
.muted {
  color: var(--text-muted);
}
</style>

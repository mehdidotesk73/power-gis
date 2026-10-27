<script setup lang="ts">
// A transform output's preview: its first rows (or the SQL's error), the full row count and column types.
import { isGeometryColumn, type ColumnInfo } from '../../lib/dataset/columns'
import type { DataRecord } from '../../lib/data/connectors'

defineProps<{ preview: { columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number } | { error: string }; label?: string }>()
/** A cell as short text; geometry as its kind (the full GeoJSON is noise in a table). */
function cell(v: unknown, type: string): string {
  if (v === null || v === undefined) return ''
  // SQL hands geometry back as GeoJSON text; show its kind either way.
  if (isGeometryColumn(type as never)) return typeof v === 'object' ? String((v as { type?: string }).type ?? type) : (/"type"\s*:\s*"(\w+)"/.exec(String(v))?.[1] ?? String(v).slice(0, 24))
  return (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60)
}
</script>

<template>
  <p v-if="'error' in preview" class="bad">{{ label ? `${label}: ` : '' }}{{ preview.error }}</p>
  <div v-else class="preview">
    <p class="muted">{{ label ? `${label} · ` : '' }}{{ preview.rowCount.toLocaleString() }} rows · first {{ preview.rows.length }}</p>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th v-for="c in preview.columns" :key="c.name">{{ c.name }}<br /><span class="muted">{{ c.type }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in preview.rows" :key="i">
            <td v-for="c in preview.columns" :key="c.name">{{ cell(r[c.name], c.type) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.preview {
  display: grid;
  gap: 0.2rem;
  min-width: 0;
}
.scroll {
  overflow: auto;
  max-height: 14rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
}
table {
  border-collapse: collapse;
  font-size: 0.72rem;
  width: 100%;
}
th,
td {
  padding: 0.15rem 0.35rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
  white-space: nowrap;
}
th {
  position: sticky;
  top: 0;
  background: var(--bg-elev);
}
.muted {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.72rem;
}
.bad {
  margin: 0;
  color: var(--danger);
  font-size: 0.74rem;
}
</style>

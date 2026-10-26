<script setup lang="ts">
// The workspace's datasets: tables in the database, by pointer. Drag ≡ to
// reorder; ⧉ copies the dataset id (paste it into a transform's input search); ▤ previews the first rows; ✎ renames or describes (a server request) and shows the
// profile. ✕ takes a dataset out of the workspace — the
// table stays in the database. (Visualizations are added from the
// Visualizations panel; how rows map to features is part of each one.)
import { ref } from 'vue'
import { useDragReorder } from './useDragReorder'
import { readDb } from '../../client/db'
import type { DatasetRecord } from '../../shared/records'
import type { DataRecord } from '../../lib/data/connectors'
import { isGeometryColumn } from '../../lib/dataset/columns'

const props = defineProps<{ datasets: DatasetRecord[]; vizCount: (id: string) => number }>()
const emit = defineEmits<{
  (e: 'zoom', id: string): void
  (e: 'remove', id: string): void
  (e: 'reorder', ids: string[]): void
  (e: 'update', id: string, patch: { name?: string; description?: string }): void
}>()

const listEl = ref<HTMLElement>()
const { dragging, onHandleDown, onHandleMove, onHandleUp } = useDragReorder(
  listEl,
  () => props.datasets.map((d) => d.id),
  (ids) => emit('reorder', ids),
)
const editing = ref<string | null>(null)

// ── copy a dataset id ──────────────────────────────────────────────────────

const copied = ref<string | null>(null)
async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
  } catch {
    // No clipboard API (or no permission): select the text for a manual copy.
    const ta = document.createElement('textarea')
    ta.value = id
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  copied.value = id
  setTimeout(() => copied.value === id && (copied.value = null), 1500)
}

// ── preview: the first rows, read straight from the database ──────────────

const PREVIEW_ROWS = 20
const previewing = ref<string | null>(null)
const previewRows = ref<DataRecord[]>([])
const previewError = ref('')
async function togglePreview(ds: DatasetRecord) {
  if (previewing.value === ds.id) return void (previewing.value = null)
  previewing.value = ds.id
  previewRows.value = []
  previewError.value = ''
  try {
    const rows = await readDb.readRows(ds.table)
    if (previewing.value === ds.id) previewRows.value = (rows ?? []).slice(0, PREVIEW_ROWS)
  } catch (e) {
    previewError.value = (e as Error).message
  }
}
/** A cell as short text; geometry as its kind (the full GeoJSON is noise in a table). */
function cell(v: unknown, type: string): string {
  if (v === null || v === undefined) return ''
  if (isGeometryColumn(type as never)) return typeof v === 'object' ? String((v as { type?: string }).type ?? type) : String(v).slice(0, 24)
  return (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60)
}
const stats = (d: DatasetRecord) => `${plural(d.rowCount, 'row')} · ${plural(d.columns.length, 'column')}`
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—')
/** Numbers compact, datetimes as dates. */
const short = (v: unknown) =>
  typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v ?? '').replace(/T00:00:00(\.000)?Z$/, '').slice(0, 19)
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
</script>

<template>
  <ul ref="listEl" class="list">
    <li v-for="ds in datasets" :key="ds.id" :data-id="ds.id" class="ds" :class="{ dragging: dragging === ds.id }">
      <div class="head">
        <span
          v-if="datasets.length > 1"
          class="handle"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          @pointerdown="onHandleDown($event, ds.id)"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
          >≡</span
        >
        <div class="title">
          <strong>{{ ds.name }}</strong>
          <span v-if="ds.description" class="desc">{{ ds.description }}</span>
          <span class="muted">{{ stats(ds) }} · {{ ds.origin }}</span>
        </div>
        <button class="icon" :class="{ on: copied === ds.id }" :title="`Copy dataset id (${ds.id})`" @click="copyId(ds.id)">{{ copied === ds.id ? '✓' : '⧉' }}</button>
        <button class="icon" :class="{ on: previewing === ds.id }" title="Preview the first rows" @click="togglePreview(ds)">▤</button>
        <button class="icon" :class="{ on: editing === ds.id }" title="Rename / describe" @click="editing = editing === ds.id ? null : ds.id">✎</button>
        <button class="icon" title="Zoom to data" @click="emit('zoom', ds.id)">⤢</button>
        <button class="icon" title="Take out of the workspace (stays in the database)" @click="emit('remove', ds.id)">✕</button>
      </div>
      <div v-if="editing === ds.id" class="edit">
        <label>
          Name
          <input type="text" :value="ds.name" @change="emit('update', ds.id, { name: ($event.target as HTMLInputElement).value })" />
        </label>
        <label>
          Description
          <textarea
            rows="2"
            :value="ds.description ?? ''"
            placeholder="What this data is, where it's from"
            @change="emit('update', ds.id, { description: ($event.target as HTMLTextAreaElement).value })"
          />
        </label>
        <div v-if="ds.profile" class="profile">
          <div class="lbl">Profile · {{ Math.round(ds.profile.completeness * 100) }}% of cells filled</div>
          <div class="scroll">
            <table>
              <thead>
                <tr><th>Column</th><th>Type</th><th>Filled</th><th>Distinct</th><th>Range</th></tr>
              </thead>
              <tbody>
                <tr v-for="c in ds.profile.columns" :key="c.name">
                  <td>{{ c.name }}</td>
                  <td>{{ c.type }}</td>
                  <td>{{ pct(c.filled, ds.profile.rowCount) }}</td>
                  <td>{{ c.distinct.toLocaleString() }}</td>
                  <td>{{ c.min === undefined ? '' : `${short(c.min)} – ${short(c.max)}` }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <span class="muted">Id <code class="id">{{ ds.id }}</code></span>
        <span class="muted">Added {{ new Date(ds.createdAt).toLocaleString() }}</span>
      </div>
      <div v-if="previewing === ds.id" class="preview">
        <p v-if="previewError" class="warn">{{ previewError }}</p>
        <template v-else>
          <span class="muted">First {{ Math.min(PREVIEW_ROWS, ds.rowCount).toLocaleString() }} of {{ ds.rowCount.toLocaleString() }} rows</span>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th v-for="c in ds.columns" :key="c.name">{{ c.name }}<br /><span class="muted">{{ c.type }}</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in previewRows" :key="i">
                  <td v-for="c in ds.columns" :key="c.name">{{ cell(r[c.name], c.type) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
      <p class="muted uses">Used by {{ plural(vizCount(ds.id), 'visualization') }}</p>
    </li>
  </ul>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.ds {
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0.4rem 0.5rem;
}
.profile {
  display: grid;
  gap: 0.2rem;
  min-width: 0;
}
.lbl {
  font-weight: 600;
  font-size: 0.76rem;
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
.id {
  font-size: 0.7rem;
  word-break: break-all;
  user-select: all;
}
.preview {
  display: grid;
  gap: 0.2rem;
  margin-top: 0.35rem;
  min-width: 0;
}
.ds.dragging {
  opacity: 0.7;
  outline: 1px solid var(--accent-blue);
}
.handle {
  cursor: grab;
  touch-action: none;
  user-select: none;
  color: var(--text-muted);
  font-size: 1.1rem;
  line-height: 1.2;
  padding: 0 0.3rem 0 0;
}
.desc {
  font-size: 0.76rem;
}
.icon.on {
  color: var(--accent-blue);
}
.edit {
  display: grid;
  gap: 0.35rem;
  margin-top: 0.35rem;
  font-size: 0.8rem;
}
.edit label {
  display: grid;
  gap: 0.15rem;
}
.edit input,
.edit textarea {
  font: inherit;
  padding: 0.3rem;
  font-size: 16px; /* below 16px iOS zooms the page on focus */
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 0.3rem;
}
.title {
  flex: 1;
  display: grid;
  min-width: 0;
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
}
.icon {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 0.9rem;
  padding: 0 0.2rem;
}
.warn {
  margin: 0.25rem 0 0;
  font-size: 0.72rem;
  color: #b26a00;
}
.uses {
  margin: 0.25rem 0 0;
}
</style>

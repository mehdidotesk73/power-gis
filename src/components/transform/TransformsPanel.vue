<script setup lang="ts">
// Transforms: SQL that makes datasets from datasets. Each has inputs (a
// dataset and the table name the SQL calls it), one SELECT query, and an
// output dataset once it has run. Preview runs the SQL on the server and
// shows the first rows without storing anything; Run stores the result as
// the output dataset (a new one the first time). Edits are part of the
// workspace draft, saved with Save.
import { computed, ref } from 'vue'
import { request } from '../../client/api'
import type { DatasetRecord } from '../../shared/records'
import type { ColumnInfo } from '../../lib/dataset/columns'
import type { DataRecord } from '../../lib/data/connectors'
import { aliasFor, type TransformSpec } from '../../lib/workspace/workspace'
import { newId } from '../../lib/dataset/dataset'

export type RunStatus = { state: 'running' } | { state: 'done'; message: string } | { state: 'error'; message: string }

const props = defineProps<{
  transforms: TransformSpec[]
  /** The workspace's datasets: possible inputs. */
  datasets: DatasetRecord[]
  /** Any dataset's name by id (outputs may not be in the workspace). */
  nameOf: (id: string) => string | undefined
  status: Record<string, RunStatus>
}>()
const emit = defineEmits<{
  (e: 'add', t: TransformSpec): void
  (e: 'update', t: TransformSpec): void
  (e: 'remove', id: string): void
  (e: 'run', id: string): void
}>()

const editing = ref<string | null>(null)
const message = (id: string) => {
  const s = props.status[id]
  return s && 'message' in s ? s.message : ''
}

function create() {
  const d = props.datasets[0]
  if (!d) return
  const alias = aliasFor(d.name)
  const t: TransformSpec = { id: newId(), name: 'New transform', sql: `SELECT *\nFROM ${alias}`, inputs: [{ datasetId: d.id, alias }] }
  emit('add', t)
  editing.value = t.id
  preview.value = null
}

const patch = (t: TransformSpec, p: Partial<TransformSpec>) => emit('update', { ...t, ...p })

function setInput(t: TransformSpec, i: number, p: Partial<TransformSpec['inputs'][number]>) {
  const inputs = t.inputs.map((x, j) => (j === i ? { ...x, ...p } : x))
  // A dataset picked for an input gets its default table name unless one was typed.
  if (p.datasetId) inputs[i].alias = aliasFor(props.datasets.find((d) => d.id === p.datasetId)?.name ?? 'input')
  patch(t, { inputs })
}
function addInput(t: TransformSpec) {
  const used = new Set(t.inputs.map((i) => i.datasetId))
  const d = props.datasets.find((x) => !used.has(x.id)) ?? props.datasets[0]
  if (d) patch(t, { inputs: [...t.inputs, { datasetId: d.id, alias: aliasFor(d.name) }] })
}

const describe = (t: TransformSpec) =>
  `${t.inputs.map((i) => i.alias).join(', ')} → ${t.outputId ? (props.nameOf(t.outputId) ?? 'missing dataset') : 'new dataset'}`

// ── preview ────────────────────────────────────────────────────────────────

const preview = ref<{ id: string; columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number } | { id: string; error: string } | null>(null)
const previewing = ref(false)
async function runPreview(t: TransformSpec) {
  previewing.value = true
  const r = await request('previewTransform', { sql: t.sql, inputs: t.inputs, limit: 20 })
  previewing.value = false
  preview.value = r.ok ? { id: t.id, ...r.data } : { id: t.id, error: r.error.message }
}
const shown = computed(() => (preview.value && editing.value === preview.value.id ? preview.value : null))
const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60)
</script>

<template>
  <div class="transforms">
    <button class="add-btn" :disabled="!datasets.length" @click="create">＋ New transform</button>
    <p v-if="!transforms.length" class="muted">
      No transforms yet. A transform is a SQL query over your datasets — joins, filters, sums, or building a point from latitude and
      longitude — whose result becomes a new dataset.
    </p>
    <ul class="list">
      <li v-for="t in transforms" :key="t.id" class="tr">
        <div class="head">
          <div class="title">
            <strong>{{ t.name }}</strong>
            <span class="muted">{{ describe(t) }}</span>
            <span v-if="status[t.id]?.state === 'running'" class="muted">Running…</span>
            <span v-else-if="status[t.id]?.state === 'done'" class="ok">{{ message(t.id) }}</span>
            <span v-else-if="status[t.id]?.state === 'error'" class="bad">{{ message(t.id) }}</span>
          </div>
          <button class="btn primary" :disabled="status[t.id]?.state === 'running'" @click="emit('run', t.id)">Run</button>
          <button class="btn" :class="{ on: editing === t.id }" @click="editing = editing === t.id ? null : t.id">{{ editing === t.id ? 'Done' : 'Edit' }}</button>
        </div>

        <div v-if="editing === t.id" class="ed">
          <label class="row">Name <input type="text" :value="t.name" @change="patch(t, { name: ($event.target as HTMLInputElement).value })" /></label>

          <div class="lbl">Inputs <span class="muted">(dataset → table name in the SQL)</span></div>
          <div v-for="(inp, i) in t.inputs" :key="i" class="input">
            <select :value="inp.datasetId" aria-label="Input dataset" @change="setInput(t, i, { datasetId: ($event.target as HTMLSelectElement).value })">
              <option v-for="d in datasets" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
            <input type="text" :value="inp.alias" aria-label="Table name" autocapitalize="off" spellcheck="false" @change="setInput(t, i, { alias: ($event.target as HTMLInputElement).value.trim() })" />
            <button v-if="t.inputs.length > 1" class="icon" aria-label="Remove input" @click="patch(t, { inputs: t.inputs.filter((_, j) => j !== i) })">✕</button>
          </div>
          <button class="btn link" @click="addInput(t)">＋ Add an input</button>

          <label class="lbl" :for="`sql-${t.id}`">SQL <span class="muted">(one SELECT; DuckDB)</span></label>
          <textarea
            :id="`sql-${t.id}`"
            class="sql"
            rows="6"
            :value="t.sql"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @change="patch(t, { sql: ($event.target as HTMLTextAreaElement).value })"
          />
          <p class="muted">
            Helpers: <code>point(lon, lat)</code> makes a point · <code>vector(east, north)</code> makes a vector. Geometry columns are GeoJSON
            text in SQL.
          </p>
          <div class="row end">
            <button class="btn" :disabled="previewing" @click="runPreview(t)">{{ previewing ? 'Previewing…' : 'Preview' }}</button>
            <button class="btn danger" @click="emit('remove', t.id)">Remove</button>
          </div>

          <p v-if="shown && 'error' in shown" class="bad">{{ shown.error }}</p>
          <div v-else-if="shown" class="preview">
            <p class="muted">{{ shown.rowCount.toLocaleString() }} rows · first {{ shown.rows.length }}</p>
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th v-for="c in shown.columns" :key="c.name">{{ c.name }}<br /><span class="muted">{{ c.type }}</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in shown.rows" :key="i">
                    <td v-for="c in shown.columns" :key="c.name">{{ cell(r[c.name]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.transforms {
  display: grid;
  gap: 0.45rem;
  font-size: 0.82rem;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.tr {
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0.4rem 0.5rem;
  min-width: 0;
}
.head {
  display: flex;
  gap: 0.3rem;
  align-items: flex-start;
}
.title {
  flex: 1;
  display: grid;
  min-width: 0;
}
.ed {
  display: grid;
  gap: 0.4rem;
  margin-top: 0.45rem;
  min-width: 0;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.row.end {
  justify-content: flex-end;
}
.row input {
  flex: 1;
  min-width: 0;
  width: 0;
  max-width: 13rem;
  padding: 0.3rem;
  font-size: 16px; /* below 16px iOS zooms on focus */
}
.lbl {
  font-weight: 600;
  font-size: 0.78rem;
}
.input {
  display: flex;
  gap: 0.25rem;
}
.input select,
.input input {
  flex: 1;
  min-width: 0;
  width: 0;
  padding: 0.25rem;
  font-size: 16px;
}
.sql {
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 16px;
  padding: 0.35rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--text);
}
code {
  font-size: 0.72rem;
}
.preview {
  display: grid;
  gap: 0.25rem;
  min-width: 0;
}
.scroll {
  overflow: auto;
  max-height: 16rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
}
table {
  border-collapse: collapse;
  font-size: 0.72rem;
}
th,
td {
  padding: 0.2rem 0.4rem;
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
  color: var(--text-muted);
  font-size: 0.72rem;
  margin: 0;
}
.ok {
  color: #2e7d32;
  font-size: 0.74rem;
}
.bad {
  color: var(--danger);
  font-size: 0.74rem;
  margin: 0;
  white-space: pre-wrap;
}
.btn {
  padding: 0.25rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.78rem;
}
.btn.on {
  border-color: var(--accent-blue);
}
.btn.primary {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: #fff;
}
.btn.primary:disabled {
  opacity: 0.5;
}
.btn.danger {
  color: var(--danger);
}
.btn.link {
  border: none;
  background: none;
  color: var(--accent-blue);
  padding: 0;
  justify-self: start;
}
.icon {
  background: none;
  border: none;
  color: var(--text-muted);
}
.add-btn {
  width: 100%;
  padding: 0.45rem;
  border: 1px dashed var(--accent-blue);
  border-radius: 0.4rem;
  background: none;
  color: var(--accent-blue);
  font-size: 0.85rem;
}
.add-btn:disabled {
  opacity: 0.5;
}
</style>

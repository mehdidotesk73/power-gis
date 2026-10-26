<script setup lang="ts">
// Transforms: SQL that makes datasets from datasets. Each has inputs (a
// dataset "as" the table name the SQL calls it — Insert puts that name into
// the SQL at the cursor; renaming it renames it in the SQL), one SELECT query, and an
// output dataset once it has run. Preview runs the SQL on the server and
// shows the first rows without storing anything; Run stores the result as
// the output dataset (a new one the first time). Edits are part of the
// workspace draft, saved with Save. Cards in an ObjectList: hold one
// (right-click with a mouse) for Run, Edit and Delete.
import { computed, nextTick, ref } from 'vue'
import { request } from '../../client/api'
import SearchBox from '../map/SearchBox.vue'
import ObjectList, { type ObjectAction } from '../list/ObjectList.vue'
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
  /** Shown under the graph: no ＋ button, hint or empty message. */
  compact?: boolean
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

const actions = (t: TransformSpec): ObjectAction[] => [
  { id: 'run', icon: '▶', label: props.status[t.id]?.state === 'running' ? 'Running…' : 'Run', disabled: props.status[t.id]?.state === 'running' },
  { id: 'edit', icon: '✎', label: editing.value === t.id ? 'Close edit' : 'Edit' },
  { id: 'delete', icon: '✕', label: 'Delete', danger: true },
]
function onAction(id: string, t: TransformSpec) {
  if (id === 'run') emit('run', t.id)
  else if (id === 'edit') editing.value = editing.value === t.id ? null : t.id
  else if (id === 'delete') emit('remove', t.id)
}

function setInput(t: TransformSpec, i: number, p: Partial<TransformSpec['inputs'][number]>) {
  const inputs = t.inputs.map((x, j) => (j === i ? { ...x, ...p } : x))
  // A dataset picked for an input gets its default table name.
  if (p.datasetId) inputs[i].alias = aliasFor(props.datasets.find((d) => d.id === p.datasetId)?.name ?? 'input')
  // Renaming a table renames it in the SQL too (whole words only), so the two can't drift apart.
  const before = t.inputs[i].alias
  const after = inputs[i].alias
  const sql = currentSql(t)
  patch(t, { inputs, sql: after && before !== after ? sql.replace(new RegExp(`\\b${escapeRe(before)}\\b`, 'g'), after) : sql })
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ── insert a table name into the SQL at the cursor ─────────────────────────

// A function ref: inside v-for a string ref would collect an array. Only the open editor has a textarea.
const sqlEl = ref<HTMLTextAreaElement>()
/** The SQL as typed (the textarea commits on blur, so read it directly while editing). */
const currentSql = (t: TransformSpec) => (editing.value === t.id && sqlEl.value ? sqlEl.value.value : t.sql)
async function insert(t: TransformSpec, alias: string) {
  const el = sqlEl.value
  const text = currentSql(t)
  const start = el?.selectionStart ?? text.length
  const end = el?.selectionEnd ?? start
  const before = text.slice(0, start)
  const pad = before && !/\s$/.test(before) ? ' ' : ''
  patch(t, { sql: `${before}${pad}${alias}${text.slice(end)}` })
  await nextTick()
  if (el) {
    const at = start + pad.length + alias.length
    el.focus()
    el.setSelectionRange(at, at)
  }
}
function addInput(t: TransformSpec) {
  const used = new Set(t.inputs.map((i) => i.datasetId))
  const d = props.datasets.find((x) => !used.has(x.id)) ?? props.datasets[0]
  if (d) patch(t, { inputs: [...t.inputs, { datasetId: d.id, alias: aliasFor(d.name) }] })
}

const nameIn = (id: string) => props.datasets.find((d) => d.id === id)?.name ?? props.nameOf(id) ?? 'missing dataset'
const describe = (t: TransformSpec) =>
  `${t.inputs.map((i) => i.alias).join(', ')} → ${t.outputId ? (props.nameOf(t.outputId) ?? 'missing dataset') : 'new dataset'}`

// ── preview ────────────────────────────────────────────────────────────────

const preview = ref<{ id: string; columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number } | { id: string; error: string } | null>(null)
const previewing = ref(false)
async function runPreview(t: TransformSpec) {
  previewing.value = true
  const r = await request('previewTransform', { sql: currentSql(t), inputs: t.inputs, limit: 20 })
  previewing.value = false
  preview.value = r.ok ? { id: t.id, ...r.data } : { id: t.id, error: r.error.message }
}
const shown = computed(() => (preview.value && editing.value === preview.value.id ? preview.value : null))
defineExpose({ edit: (id: string) => (editing.value = id) })

const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60)
</script>

<template>
  <div class="transforms">
    <button v-if="!compact" class="add-btn" :disabled="!datasets.length" @click="create">＋ New transform</button>
    <p v-if="!transforms.length && !compact" class="muted">
      No transforms yet. A transform is a SQL query over your datasets — joins, filters, sums, or building a point from latitude and
      longitude — whose result becomes a new dataset.
    </p>
    <ObjectList
      :items="transforms"
      :item-key="(t) => t.id"
      :item-label="(t) => t.name"
      :actions="actions"
      :hint="compact ? '' : 'Tap and hold a transform to run, edit or delete it.'"
      @action="onAction"
    >
      <template #default="{ item: t }">
        <div class="title">
          <strong>{{ t.name }}</strong>
          <span class="muted">{{ describe(t) }}</span>
          <span v-if="status[t.id]?.state === 'running'" class="muted">Running…</span>
          <span v-else-if="status[t.id]?.state === 'done'" class="ok">{{ message(t.id) }}</span>
          <span v-else-if="status[t.id]?.state === 'error'" class="bad">{{ message(t.id) }}</span>
        </div>

        <div v-if="editing === t.id" class="ed">
          <label class="row">Name <input type="text" :value="t.name" @change="patch(t, { name: ($event.target as HTMLInputElement).value })" /></label>

          <div class="lbl">Inputs <span class="muted">(search by name or paste a dataset id; each is a table in the SQL by the name after "as")</span></div>
          <div v-for="(inp, i) in t.inputs" :key="i" class="input">
            <SearchBox
              class="pick"
              :items="datasets"
              :text="(d) => d.name"
              :match="(d) => `${d.name} ${d.id} ${d.id.replace(/-/g, '')}`"
              :detail="(d) => d.id"
              :value="nameIn(inp.datasetId)"
              placeholder="Dataset name or id"
              fuzzy
              all-when-empty
              @pick="(d) => setInput(t, i, { datasetId: d.id })"
            />
            <span class="as">as</span>
            <input
              type="text"
              :value="inp.alias"
              placeholder="table name in SQL"
              aria-label="Table name in the SQL"
              autocapitalize="off"
              spellcheck="false"
              @change="setInput(t, i, { alias: ($event.target as HTMLInputElement).value.trim() })"
            />
            <button class="btn" title="Insert this table name into the SQL at the cursor" @click="insert(t, inp.alias)">Insert</button>
            <button v-if="t.inputs.length > 1" class="icon" aria-label="Remove input" @click="patch(t, { inputs: t.inputs.filter((_, j) => j !== i) })">✕</button>
          </div>
          <button class="btn link" @click="addInput(t)">＋ Add an input</button>

          <label class="lbl" :for="`sql-${t.id}`">SQL <span class="muted">(one SELECT; DuckDB)</span></label>
          <textarea
            :id="`sql-${t.id}`"
            :ref="(el) => (sqlEl = (el as HTMLTextAreaElement) ?? undefined)"
            class="sql"
            rows="6"
            :value="t.sql"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @change="patch(t, { sql: ($event.target as HTMLTextAreaElement).value })"
          />
          <p class="muted">
            Helpers: <code>point(lat, lon)</code> makes a point · <code>vector(east, north)</code> makes a vector. Geometry columns are GeoJSON
            text in SQL.
          </p>
          <div class="row end">
            <button class="btn" :disabled="previewing" @click="runPreview(t)">{{ previewing ? 'Previewing…' : 'Preview' }}</button>
            <button class="btn primary" :disabled="status[t.id]?.state === 'running'" @click="emit('run', t.id)">Run</button>
            <button class="btn" @click="editing = null">Done</button>
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
      </template>
    </ObjectList>
  </div>
</template>

<style scoped>
.transforms {
  display: grid;
  gap: 0.45rem;
  font-size: 0.82rem;
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
.input {
  flex-wrap: wrap;
  align-items: center;
}
.input .pick {
  flex: 1 1 100%; /* its own line on phones; the table name and Insert go below */
  min-width: 0;
}
.input input {
  flex: 1;
  min-width: 0;
  width: 0;
  padding: 0.25rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 16px;
}
.as {
  color: var(--text-muted);
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

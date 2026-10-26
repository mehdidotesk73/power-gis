<script setup lang="ts">
// Transforms: SQL that makes datasets from datasets. The editor sets the
// inputs (a dataset "as" the table name the SQL calls it — Insert puts that
// name into the SQL being edited; renaming it renames it in every output's
// SQL) and the outputs (each a new dataset made on Run, or an existing one no
// other transform writes) first; below, one SELECT per output, each with its
// own Preview (first rows, nothing stored). Run writes every output together.
// Edits are part of the workspace draft, saved with Save. Cards in an
// ObjectList: hold one (right-click with a mouse) for Preview, Run, Edit and
// Delete.
import { vReveal } from '../reveal'
import { nextTick, ref } from 'vue'
import { request } from '../../client/api'
import SearchBox from '../map/SearchBox.vue'
import PreviewTable from './PreviewTable.vue'
import ObjectList, { type ObjectAction } from '../list/ObjectList.vue'
import type { DatasetRecord } from '../../shared/records'
import type { ColumnInfo } from '../../lib/dataset/columns'
import type { DataRecord } from '../../lib/data/connectors'
import { aliasFor, newOutput, type TransformOutput, type TransformSpec } from '../../lib/workspace/workspace'
import { newId } from '../../lib/dataset/dataset'

export type RunStatus = { state: 'running' } | { state: 'done'; message: string } | { state: 'error'; message: string }

const props = defineProps<{
  transforms: TransformSpec[]
  /** The workspace's datasets: possible inputs and outputs. */
  datasets: DatasetRecord[]
  /** Any dataset's name by id (outputs may not be in the workspace). */
  nameOf: (id: string) => string | undefined
  status: Record<string, RunStatus>
  /** Shown under the graph: no ＋ button, hint or empty message. */
  compact?: boolean
  /** Every transform in the workspace (when `transforms` is a subset): no two may write one dataset. */
  allTransforms?: TransformSpec[]
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
  const t: TransformSpec = { id: newId(), name: 'New transform', inputs: [{ datasetId: d.id, alias }], outputs: [newOutput('New transform', `SELECT *\nFROM ${alias}`)] }
  emit('add', t)
  editing.value = t.id
}

const patch = (t: TransformSpec, p: Partial<TransformSpec>) => emit('update', { ...t, ...p })
const patchOutput = (t: TransformSpec, key: string, p: Partial<TransformOutput>) =>
  patch(t, { outputs: t.outputs.map((o) => (o.key === key ? { ...o, ...p } : { ...o, sql: currentSql(t, o) })) })

const actions = (t: TransformSpec): ObjectAction[] => [
  { id: 'preview', icon: '▤', label: hasPreview(t) ? 'Hide preview' : previewing.value ? 'Previewing…' : 'Preview', disabled: previewing.value },
  { id: 'run', icon: '▶', label: props.status[t.id]?.state === 'running' ? 'Running…' : 'Run', disabled: props.status[t.id]?.state === 'running' },
  { id: 'edit', icon: '✎', label: editing.value === t.id ? 'Close edit' : 'Edit' },
  { id: 'delete', icon: '✕', label: 'Delete', danger: true },
]
function onAction(id: string, t: TransformSpec) {
  if (id === 'preview') togglePreview(t)
  else if (id === 'run') emit('run', t.id)
  else if (id === 'edit') editing.value = editing.value === t.id ? null : t.id
  else if (id === 'delete') emit('remove', t.id)
}

// ── inputs ─────────────────────────────────────────────────────────────────

function setInput(t: TransformSpec, i: number, p: Partial<TransformSpec['inputs'][number]>) {
  const inputs = t.inputs.map((x, j) => (j === i ? { ...x, ...p } : x))
  // A dataset picked for an input gets its default table name.
  if (p.datasetId) inputs[i].alias = aliasFor(props.datasets.find((d) => d.id === p.datasetId)?.name ?? 'input')
  // Renaming a table renames it in every output's SQL too (whole words only), so they can't drift apart.
  const before = t.inputs[i].alias
  const after = inputs[i].alias
  const rename = (sql: string) => (after && before !== after ? sql.replace(new RegExp(`\\b${escapeRe(before)}\\b`, 'g'), after) : sql)
  patch(t, { inputs, outputs: t.outputs.map((o) => ({ ...o, sql: rename(currentSql(t, o)) })) })
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function addInput(t: TransformSpec) {
  const used = new Set(t.inputs.map((i) => i.datasetId))
  const d = props.datasets.find((x) => !used.has(x.id)) ?? props.datasets[0]
  if (d) patch(t, { inputs: [...t.inputs, { datasetId: d.id, alias: aliasFor(d.name) }] })
}

// ── outputs ────────────────────────────────────────────────────────────────

/** Datasets an output may write: not an input, not another output's (of this or any transform). */
function outputChoices(t: TransformSpec, o: TransformOutput) {
  const taken = new Set(
    (props.allTransforms ?? props.transforms)
      .flatMap((x) => x.outputs.filter((y) => !(x.id === t.id && y.key === o.key)))
      .flatMap((y) => (y.outputId ? [y.outputId] : [])),
  )
  const inputs = new Set(t.inputs.map((i) => i.datasetId))
  return props.datasets.filter((d) => !taken.has(d.id) && !inputs.has(d.id))
}
function addOutput(t: TransformSpec) {
  const first = t.inputs[0]?.alias ?? 'input'
  patch(t, { outputs: [...t.outputs.map((o) => ({ ...o, sql: currentSql(t, o) })), newOutput(`${t.name} ${t.outputs.length + 1}`, `SELECT *\nFROM ${first}`)] })
}
function removeOutput(t: TransformSpec, key: string) {
  patch(t, { outputs: t.outputs.filter((o) => o.key !== key).map((o) => ({ ...o, sql: currentSql(t, o) })) })
}

// ── SQL editors (one per output) ───────────────────────────────────────────

const sk = (t: TransformSpec, o: TransformOutput) => `${t.id}:${o.key}`
// Function refs: inside v-for a string ref would collect an array.
const sqlEls = new Map<string, HTMLTextAreaElement>()
const setSqlEl = (key: string, el: unknown) => (el ? sqlEls.set(key, el as HTMLTextAreaElement) : sqlEls.delete(key))
/** The output whose SQL was edited last: where Insert puts a table name. */
const activeSql = ref<string | null>(null)
/** The SQL as typed (a textarea commits on blur, so read it directly while editing). */
const currentSql = (t: TransformSpec, o: TransformOutput) => sqlEls.get(sk(t, o))?.value ?? o.sql

async function insert(t: TransformSpec, alias: string) {
  const o = t.outputs.find((x) => sk(t, x) === activeSql.value) ?? t.outputs[0]
  if (!o) return
  const el = sqlEls.get(sk(t, o))
  const text = currentSql(t, o)
  const start = el?.selectionStart ?? text.length
  const end = el?.selectionEnd ?? start
  const before = text.slice(0, start)
  const pad = before && !/\s$/.test(before) ? ' ' : ''
  patchOutput(t, o.key, { sql: `${before}${pad}${alias}${text.slice(end)}` })
  await nextTick()
  if (el) {
    const at = start + pad.length + alias.length
    el.focus()
    el.setSelectionRange(at, at)
  }
}

const nameIn = (id: string) => props.datasets.find((d) => d.id === id)?.name ?? props.nameOf(id) ?? 'missing dataset'
const outName = (o: TransformOutput) => (o.outputId ? nameIn(o.outputId) : `${o.name || 'new dataset'} (new)`)
const describe = (t: TransformSpec) => `${t.inputs.map((i) => i.alias).join(', ')} → ${t.outputs.map(outName).join(', ')}`

// ── preview (per output) ───────────────────────────────────────────────────

type Preview = { columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number } | { error: string }
const previews = ref<Record<string, Preview>>({})
const previewing = ref(false)
async function previewOutput(t: TransformSpec, o: TransformOutput) {
  previewing.value = true
  const r = await request('previewTransform', { sql: currentSql(t, o), inputs: t.inputs, limit: 20 })
  previewing.value = false
  previews.value = { ...previews.value, [sk(t, o)]: r.ok ? r.data : { error: r.error.message } }
}
const hasPreview = (t: TransformSpec) => t.outputs.some((o) => previews.value[sk(t, o)])
function clearPreviews(t: TransformSpec) {
  const next = { ...previews.value }
  for (const o of t.outputs) delete next[sk(t, o)]
  previews.value = next
}
/** The card's Preview: every output's first rows, or hide them. */
async function togglePreview(t: TransformSpec) {
  if (hasPreview(t)) return clearPreviews(t)
  for (const o of t.outputs) await previewOutput(t, o)
}

defineExpose({ edit: (id: string) => (editing.value = id) })
</script>

<template>
  <div class="transforms">
    <button v-if="!compact" class="add-btn" :disabled="!datasets.length" @click="create">＋ New transform</button>
    <p v-if="!transforms.length && !compact" class="muted">
      No transforms yet. A transform is SQL over your datasets — joins, filters, sums, or building a point from latitude and longitude —
      whose results become datasets.
    </p>
    <ObjectList
      :items="transforms"
      :item-key="(t) => t.id"
      :item-label="(t) => t.name"
      :actions="actions"
      :hint="compact ? '' : 'Tap and hold a transform to preview, run, edit or delete it.'"
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

        <div v-if="editing === t.id" v-reveal class="ed">
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
            <button class="btn" title="Insert this table name into the SQL you're editing" @click="insert(t, inp.alias)">Insert</button>
            <button v-if="t.inputs.length > 1" class="icon" aria-label="Remove input" @click="patch(t, { inputs: t.inputs.filter((_, j) => j !== i) })">✕</button>
          </div>
          <button class="btn link" @click="addInput(t)">＋ Add an input</button>

          <div class="lbl">Outputs <span class="muted">(each has its own SQL below; Run writes them all)</span></div>
          <div v-for="o in t.outputs" :key="o.key" class="output">
            <input
              type="text"
              :value="o.name"
              :disabled="!!o.outputId"
              :placeholder="o.outputId ? '' : 'New dataset name'"
              aria-label="Output name"
              @change="patchOutput(t, o.key, { name: ($event.target as HTMLInputElement).value })"
            />
            <select :value="o.outputId ?? ''" aria-label="Writes to" @change="patchOutput(t, o.key, { outputId: ($event.target as HTMLSelectElement).value || undefined })">
              <option value="">New dataset</option>
              <option v-for="d in outputChoices(t, o)" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
            <button v-if="t.outputs.length > 1" class="icon" aria-label="Remove output" @click="removeOutput(t, o.key)">✕</button>
          </div>
          <p class="muted">An existing dataset's rows are replaced on Run — pick one whose transform was deleted to make it updatable again.</p>
          <button class="btn link" @click="addOutput(t)">＋ Add an output</button>

          <section v-for="o in t.outputs" :key="o.key" class="out-sql">
            <label class="lbl" :for="`sql-${sk(t, o)}`">SQL → {{ outName(o) }} <span class="muted">(one SELECT; DuckDB)</span></label>
            <textarea
              :id="`sql-${sk(t, o)}`"
              :ref="(el) => setSqlEl(sk(t, o), el)"
              class="sql"
              rows="6"
              :value="o.sql"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              @focus="activeSql = sk(t, o)"
              @change="patchOutput(t, o.key, { sql: ($event.target as HTMLTextAreaElement).value })"
            />
            <div class="row end">
              <button class="btn" :disabled="previewing" @click="previews[sk(t, o)] ? clearPreviews(t) : previewOutput(t, o)">
                {{ previews[sk(t, o)] ? 'Hide preview' : previewing ? 'Previewing…' : 'Preview' }}
              </button>
            </div>
            <PreviewTable v-if="previews[sk(t, o)]" :preview="previews[sk(t, o)]" />
          </section>
          <p class="muted">
            Helpers: <code>point(lat, lon)</code> makes a point · <code>vector(east, north)</code> makes a vector. Geometry columns are GeoJSON
            text in SQL.
          </p>
          <div class="row end">
            <button class="btn primary" :disabled="status[t.id]?.state === 'running'" @click="emit('run', t.id)">
              Run{{ t.outputs.length > 1 ? ` (${t.outputs.length} outputs)` : '' }}
            </button>
            <button class="btn" @click="editing = null">Done</button>
          </div>
        </div>

        <!-- Previews from the card's menu, while not editing -->
        <template v-else>
          <PreviewTable v-for="o in t.outputs.filter((x) => previews[sk(t, x)])" :key="o.key" :preview="previews[sk(t, o)]" :label="outName(o)" />
        </template>
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
  grid-template-columns: minmax(0, 1fr); /* never wider than the card */
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
.output {
  display: flex;
  gap: 0.35rem;
  align-items: center;
}
.output input {
  flex: 1;
  min-width: 0;
  padding: 0.3rem;
  font-size: 16px;
}
.output select {
  flex: 1;
  min-width: 0;
  max-width: 11rem;
  padding: 0.3rem;
  font-size: 0.85rem;
}
.out-sql {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.3rem;
  padding-top: 0.4rem;
  border-top: 1px dashed var(--border);
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
  background: var(--bg-input);
  color: var(--text);
}
code {
  font-size: 0.72rem;
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
  margin: 0;
}
.ok {
  color: var(--ok);
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
  color: var(--on-accent);
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

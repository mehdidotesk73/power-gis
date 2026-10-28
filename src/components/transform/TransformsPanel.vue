<script setup lang="ts">
// Transforms: SQL that makes datasets from datasets. The editor sets the
// inputs (a dataset "as" the table name the SQL calls it — Insert puts that
// name into the SQL being edited; renaming it renames it in every output's
// SQL) and the outputs (each a new dataset made on Run, or an existing one no
// other transform writes) first; below, one SELECT per output, each with its
// own Preview (first rows, nothing stored). Run writes every output together.
// Inputs and outputs are one compact line each; tapping one previews it in
// the dock at the bottom of the editor (one at a time, collapsible): an
// input's first rows, or what an output's SQL would write.
// Edits are part of the workspace draft, saved with Save. Cards in an
// ObjectList: hold one (right-click with a mouse) for Preview, Run, Edit and
// Delete.
import UiButton from '../ui/UiButton.vue'
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
  else if (id === 'edit') editing.value === t.id ? closeEditor() : (editing.value = t.id)
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
  if (!d) return
  patch(t, { inputs: [...t.inputs, { datasetId: d.id, alias: aliasFor(d.name) }] })
  changing.value = t.inputs.length
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

// ── the editor's preview dock: one input or output at a time ───────────────

type DockTarget = { kind: 'input'; index: number } | { kind: 'output'; key: string }
const dockOn = ref<DockTarget | null>(null)
const dockOpen = ref(true)
const dock = ref<Preview | null>(null)
const dockBusy = ref(false)
let dockSeq = 0
const isDocked = (d: DockTarget) =>
  !!dockOn.value && dockOn.value.kind === d.kind && (d.kind === 'input' ? d.index === (dockOn.value as { index: number }).index : d.key === (dockOn.value as { key: string }).key)
function dockLabel(t: TransformSpec) {
  const d = dockOn.value
  if (!d) return ''
  if (d.kind === 'input') {
    const inp = t.inputs[d.index]
    return inp ? `${nameIn(inp.datasetId)} as ${inp.alias}` : ''
  }
  const o = t.outputs.find((x) => x.key === d.key)
  return o ? `${outName(o)} (from its SQL)` : ''
}
/** Shows an input's first rows, or what an output's SQL would write (nothing is stored). */
async function showInDock(t: TransformSpec, d: DockTarget) {
  dockOn.value = d
  dockOpen.value = true
  dock.value = null
  dockBusy.value = true
  const mine = ++dockSeq
  let result: Preview
  if (d.kind === 'input') {
    const ds = props.datasets.find((x) => x.id === t.inputs[d.index]?.datasetId)
    if (!ds) result = { error: 'That dataset is not in the workspace.' }
    else {
      const r = await request('datasetRows', { datasetId: ds.id, limit: 20 })
      result = r.ok ? r.data : { error: r.error.message }
    }
  } else {
    const o = t.outputs.find((x) => x.key === d.key)
    if (!o) return
    const r = await request('previewTransform', { sql: currentSql(t, o), inputs: t.inputs, limit: 20 })
    result = r.ok ? r.data : { error: r.error.message }
  }
  if (mine !== dockSeq) return
  dock.value = result
  dockBusy.value = false
}
function closeEditor() {
  editing.value = null
  dockOn.value = null
  dock.value = null
}

/** Which input's dataset picker is open (⇄, or a freshly added input). */
const changing = ref<number | null>(null)

defineExpose({ edit: (id: string) => (editing.value = id) })
</script>

<template>
  <div class="transforms">
    <UiButton v-if="!compact" size="tag" tone="transform" icon="＋" class="add-pill" :disabled="!datasets.length" @click="create">Transform</UiButton>
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
      @open="(t) => (editing = t.id)"
    >
      <template #default="{ item: t }">
        <div class="title">
          <strong>{{ t.name }}</strong>
          <span class="muted">{{ describe(t) }}</span>
          <span v-if="t.requires?.length" class="muted" :title="`Its SQL uses the SQL engine's ${t.requires.join(', ')} extension`">· uses {{ t.requires.join(', ') }}</span>
          <span v-if="status[t.id]?.state === 'running'" class="muted">Running…</span>
          <span v-else-if="status[t.id]?.state === 'done'" class="ok">{{ message(t.id) }}</span>
          <span v-else-if="status[t.id]?.state === 'error'" class="bad">{{ message(t.id) }}</span>
        </div>

        <div v-if="editing === t.id" v-reveal class="ed" data-no-open>
          <label class="row">Name <input type="text" :value="t.name" @change="patch(t, { name: ($event.target as HTMLInputElement).value })" /></label>

          <div class="lbl">Inputs <span class="muted">— tap one to preview it below; "as" is its table name in the SQL</span></div>
          <div v-for="(inp, i) in t.inputs" :key="i" class="io">
            <template v-if="changing === i">
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
                @pick="(d) => (setInput(t, i, { datasetId: d.id }), (changing = null), showInDock(t, { kind: 'input', index: i }))"
              />
              <UiButton size="compact" icon="✓" aria-label="Keep this dataset" title="Done" @click="changing = null" />
            </template>
            <template v-else>
              <button class="chip k-dataset" :class="{ on: isDocked({ kind: 'input', index: i }) }" :title="`Preview ${nameIn(inp.datasetId)}`" @click="showInDock(t, { kind: 'input', index: i })">
                {{ nameIn(inp.datasetId) }}
              </button>
              <span class="as">as</span>
              <input
                class="alias"
                type="text"
                :value="inp.alias"
                placeholder="table"
                aria-label="Table name in the SQL"
                autocapitalize="off"
                spellcheck="false"
                @change="setInput(t, i, { alias: ($event.target as HTMLInputElement).value.trim() })"
              />
              <UiButton size="compact" icon="⤵" aria-label="Insert the table name into the SQL" title="Insert into the SQL" @click="insert(t, inp.alias)" />
              <UiButton size="compact" icon="⇄" aria-label="Use another dataset" title="Use another dataset" @click="changing = i" />
              <UiButton v-if="t.inputs.length > 1" size="compact" icon="✕" aria-label="Remove input" title="Remove" @click="patch(t, { inputs: t.inputs.filter((_, j) => j !== i) })" />
            </template>
          </div>
          <button class="btn link" @click="addInput(t)">＋ Add an input</button>

          <div class="lbl">Outputs <span class="muted">— tap one to preview what its SQL makes; Run writes them all</span></div>
          <div v-for="o in t.outputs" :key="o.key" class="io">
            <button class="chip k-out" :class="{ on: isDocked({ kind: 'output', key: o.key }) }" title="Preview this output" @click="showInDock(t, { kind: 'output', key: o.key })">▤</button>
            <input
              class="oname"
              type="text"
              :value="o.outputId ? nameIn(o.outputId) : o.name"
              :disabled="!!o.outputId"
              placeholder="New dataset name"
              aria-label="Output name"
              @change="patchOutput(t, o.key, { name: ($event.target as HTMLInputElement).value })"
            />
            <span class="as">→</span>
            <select :value="o.outputId ?? ''" aria-label="Writes to" @change="patchOutput(t, o.key, { outputId: ($event.target as HTMLSelectElement).value || undefined })">
              <option value="">New dataset</option>
              <option v-for="d in outputChoices(t, o)" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
            <UiButton v-if="t.outputs.length > 1" size="compact" icon="✕" aria-label="Remove output" title="Remove" @click="removeOutput(t, o.key)" />
          </div>
          <p class="muted">Writing to an existing dataset replaces its rows on Run — pick one whose transform was deleted to make it updatable again.</p>
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
              <button class="btn" @click="showInDock(t, { kind: 'output', key: o.key })">Preview ↓</button>
            </div>
          </section>
          <p class="muted">
            Helpers: <code>point(lat, lon)</code> makes a point · <code>vector(east, north)</code> makes a vector. Geometry columns are GeoJSON
            text in SQL.
          </p>
          <div class="row end">
            <button class="btn primary" :disabled="status[t.id]?.state === 'running'" @click="emit('run', t.id)">
              Run{{ t.outputs.length > 1 ? ` (${t.outputs.length} outputs)` : '' }}
            </button>
            <button class="btn" @click="closeEditor">Done</button>
          </div>

          <!-- One input or output at a time; sticks to the screen bottom while the editor scrolls. -->
          <section class="dock" :class="{ closed: !dockOpen }" aria-label="Preview">
            <button class="dock-head" :aria-expanded="dockOpen" @click="dockOpen = !dockOpen">
              <span class="dock-title">
                <strong>Preview</strong>
                <span class="muted">{{ dockOn ? ` · ${dockLabel(t)}` : ' · tap an input or output above' }}</span>
              </span>
              <span aria-hidden="true">{{ dockOpen ? '▾' : '▴' }}</span>
            </button>
            <div v-if="dockOpen && dockOn" class="dock-body">
              <p v-if="dockBusy" class="muted">Loading…</p>
              <PreviewTable v-else-if="dock" :preview="dock" />
            </div>
          </section>
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
.io {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}
.io .pick {
  flex: 1;
  min-width: 0;
}
.chip {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--k);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--k) 10%, transparent);
  color: var(--text);
  font-size: 0.76rem;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip.k-dataset {
  --k: var(--kind-dataset);
}
.chip.k-out {
  --k: var(--kind-dataset);
  flex: none;
  max-width: none;
}
.chip.on {
  background: color-mix(in srgb, var(--k) 30%, transparent);
  box-shadow: 0 0 0 1px var(--k);
}
.alias,
.oname {
  min-width: 0;
  padding: 0.15rem 0.35rem;
  font-size: 16px; /* below 16px iOS zooms on focus */
}
.alias {
  flex: 1 1 6rem;
  width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.oname {
  flex: 1 1 6rem;
  width: 0;
}
.io select {
  flex: 1 1 6rem;
  min-width: 0;
  width: 0;
  padding: 0.2rem;
  font-size: 0.8rem;
}
.dock {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  margin: 0.2rem -0.3rem -0.3rem;
  border: 1px solid var(--border-strong);
  border-radius: 0.5rem 0.5rem 0.4rem 0.4rem;
  background: var(--bg-elev);
  box-shadow: 0 -8px 20px rgba(0, 0, 0, 0.35);
}
.dock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.55rem;
  border: none;
  background: none;
  color: var(--text);
  font-size: 0.8rem;
  text-align: left;
}
.dock-title {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dock-body {
  padding: 0 0.5rem 0.5rem;
  max-height: 40svh;
  overflow: auto;
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
.add-pill {
  justify-self: start;
  margin-bottom: 0.45rem;
}
</style>

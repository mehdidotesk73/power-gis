<script setup lang="ts">
// Explore a dataset with SQL: a window with a SQL box (starting as SELECT *
// over the dataset) above a docked results table showing 200 rows a page.
// Every workspace dataset can be used by its table name (the chips insert
// it); only the tables the SQL names are loaded. Nothing is stored — this is
// previewTransform with paging.
import UiButton from '../ui/UiButton.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { request } from '../../client/api'
import PreviewTable from '../transform/PreviewTable.vue'
import { aliasFor } from '../../lib/workspace/workspace'
import type { DatasetRecord } from '../../shared/records'
import type { ColumnInfo } from '../../lib/dataset/columns'
import type { DataRecord } from '../../lib/data/connectors'

const props = defineProps<{ dataset: DatasetRecord; tables: DatasetRecord[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const PAGE = 200

/** Each dataset's table name in the SQL: from its name, made unique. The explored one comes first. */
const named = computed(() => {
  const seen = new Set<string>()
  const list = [props.dataset, ...props.tables.filter((t) => t.id !== props.dataset.id)]
  return list.map((d) => {
    const base = aliasFor(d.name)
    let alias = base
    for (let n = 2; seen.has(alias); n++) alias = `${base}_${n}`
    seen.add(alias)
    return { d, alias }
  })
})
const self = computed(() => named.value[0].alias)

const sql = ref(`SELECT *\nFROM ${aliasFor(props.dataset.name)}`)
const box = ref<HTMLTextAreaElement>()
type Result = { columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number } | { error: string }
const result = ref<Result | null>(null)
const page = ref(0)
const busy = ref(false)
let seq = 0

/** Only the tables the SQL mentions are loaded into the engine. */
const used = () => named.value.filter(({ alias }) => new RegExp(`\\b${alias}\\b`, 'i').test(sql.value))

async function run(toPage = 0) {
  const mine = ++seq
  busy.value = true
  page.value = toPage
  const inputs = used().map(({ d, alias }) => ({ datasetId: d.id, alias }))
  const r = await request('previewTransform', { sql: sql.value, inputs, limit: PAGE, offset: toPage * PAGE })
  if (mine !== seq) return
  busy.value = false
  // The server only knows the tables this SQL loaded; list every one that can be used.
  const all = named.value.map(({ d, alias }) => `${alias} (${d.name})`).join(', ')
  result.value = r.ok ? r.data : { error: r.error.message.replace(/Tables you can use: .*$/s, `Tables you can use: ${all}.`) }
}
const total = computed(() => (result.value && 'rowCount' in result.value ? result.value.rowCount : 0))
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE)))
const range = computed(() => {
  if (!total.value) return 'no rows'
  const from = page.value * PAGE + 1
  return `${from.toLocaleString()}–${Math.min(total.value, from + PAGE - 1).toLocaleString()} of ${total.value.toLocaleString()} rows`
})

async function insert(alias: string) {
  const el = box.value
  const start = el?.selectionStart ?? sql.value.length
  const end = el?.selectionEnd ?? start
  const before = sql.value.slice(0, start)
  const pad = before && !/\s$/.test(before) ? ' ' : ''
  sql.value = `${before}${pad}${alias}${sql.value.slice(end)}`
  await nextTick()
  const at = start + pad.length + alias.length
  el?.focus()
  el?.setSelectionRange(at, at)
}
function reset() {
  sql.value = `SELECT *\nFROM ${self.value}`
  run()
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') emit('close')
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    run()
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  run()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="emit('close')">
      <section class="explore" role="dialog" aria-modal="true" :aria-label="`Explore ${dataset.name}`">
        <header>
          <div class="title">
            <span class="eyebrow">Explore</span>
            <strong>{{ dataset.name }}</strong>
          </div>
          <UiButton size="compact" icon="✕" aria-label="Close" title="Close (Esc)" @click="emit('close')" />
        </header>

        <div class="tables">
          <span class="muted">Tables:</span>
          <button v-for="t in named" :key="t.d.id" class="chip" :class="{ self: t.d.id === dataset.id }" :title="`${t.d.name} — tap to insert`" @click="insert(t.alias)">
            {{ t.alias }}
          </button>
        </div>

        <textarea
          ref="box"
          v-model="sql"
          class="sql"
          rows="4"
          aria-label="SQL"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
        />
        <div class="actions">
          <span class="muted hint">One SELECT (DuckDB) · nothing is saved · Ctrl/⌘ + Enter runs</span>
          <button class="btn" @click="reset">Reset</button>
          <button class="btn primary" :disabled="busy" @click="run()">{{ busy ? 'Running…' : 'Run' }}</button>
        </div>

        <div class="results">
          <div v-if="result && !('error' in result)" class="pager">
            <span class="muted">{{ range }}</span>
            <span class="nav">
              <button class="btn" :disabled="busy || page === 0" @click="run(page - 1)">‹ Prev</button>
              <span class="muted">{{ page + 1 }} / {{ pages }}</span>
              <button class="btn" :disabled="busy || page + 1 >= pages" @click="run(page + 1)">Next ›</button>
            </span>
          </div>
          <p v-if="busy && !result" class="muted">Loading…</p>
          <PreviewTable v-if="result" :preview="result" class="table" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 150;
  display: grid;
  place-items: center;
  padding: 2.5vh 3vw;
  background: var(--backdrop);
}
.explore {
  box-sizing: border-box;
  width: min(72rem, 100%);
  height: min(95dvh, 52rem);
  display: grid;
  grid-template-rows: auto auto auto auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border-strong);
  border-radius: 0.7rem;
  background: var(--bg-elev);
  color: var(--text);
  box-shadow: var(--shadow);
  font-size: 0.85rem;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.title {
  display: grid;
  min-width: 0;
}
.title strong {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.eyebrow {
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--kind-dataset);
}
.tables {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  max-height: 4.2rem;
  overflow: auto;
}
.chip {
  padding: 0.1rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 1rem;
  background: var(--bg-elev-2);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.74rem;
}
.chip.self {
  border-color: var(--kind-dataset);
  background: color-mix(in srgb, var(--kind-dataset) 14%, transparent);
}
.sql {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 0.45rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 16px; /* below 16px iOS zooms on focus */
  line-height: 1.4;
}
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.4rem;
}
.actions .hint {
  margin-right: auto;
}
.results {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  gap: 0.3rem;
  min-height: 0;
  border-top: 1px solid var(--border);
  padding-top: 0.45rem;
}
/* The docked table fills the rest of the window and scrolls inside it. */
.results :deep(.preview) {
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
}
.results :deep(.preview > .muted) {
  display: none; /* the pager already says which rows these are */
}
.results :deep(.scroll) {
  max-height: none;
  height: 100%;
}
.pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
}
.nav {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.btn {
  min-height: 2rem;
  padding: 0.2rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: 0.4rem;
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 0.8rem;
}
.btn.primary {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: var(--on-accent);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.5;
}
.muted {
  color: var(--text-muted);
  font-size: 0.74rem;
}
@media (max-width: 48rem) {
  .backdrop {
    padding: 0;
  }
  .explore {
    width: 100%;
    height: 100dvh;
    border-radius: 0;
    padding: calc(0.6rem + env(safe-area-inset-top, 0px)) 0.65rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  }
  .actions .hint {
    display: none;
  }
}
</style>

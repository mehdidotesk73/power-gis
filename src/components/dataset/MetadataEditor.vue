<script setup lang="ts">
// A dataset's structured metadata (lib/dataset/metadata.ts): read as labelled
// lines, or edited as a form — what a row is and its key, the main columns
// (meaning, unit), the source (publisher and who they are, title, URLs,
// coverage, period, fetched, how it was made, terms) and caveats. Each change
// sends the whole metadata (cleaned; null when nothing's left).
import { computed, ref, watch } from 'vue'
import UiButton from '../ui/UiButton.vue'
import { cleanMetadata, metadataLines } from '../../lib/dataset/metadata'
import type { DatasetMetadata, DatasetSource } from '../../shared/records'

const props = defineProps<{
  metadata?: DatasetMetadata
  /** The dataset's column names (offered when adding a column). */
  columns: string[]
  disabled?: boolean
}>()
const emit = defineEmits<{ (e: 'change', m: DatasetMetadata | null): void }>()

const editing = ref(false)
const lines = computed(() => metadataLines(props.metadata))

// The form's copy: plain strings everywhere (lists as one line each), read back on every change.
interface Draft {
  row: string
  key: string
  columns: { name: string; meaning: string; unit: string }[]
  source: Record<keyof Omit<DatasetSource, 'urls'>, string> & { urls: string }
  caveats: string
  /** An estimated dataset's assumptions, one per line (the rest of its estimate is kept as it is). */
  assumptions: string
}
const SOURCE_FIELDS: { k: keyof Draft['source']; label: string; hint: string; long?: boolean }[] = [
  { k: 'publisher', label: 'Publisher', hint: 'CDC' },
  { k: 'publisherAbout', label: 'Who they are', hint: 'the federal public-health agency' },
  { k: 'title', label: 'Title', hint: 'PLACES county data, 2025 release' },
  { k: 'urls', label: 'URLs', hint: 'one per line', long: true },
  { k: 'coverage', label: 'Covers', hint: 'every US county except KY and PA' },
  { k: 'period', label: 'Period', hint: '2023' },
  { k: 'fetched', label: 'Fetched', hint: 'YYYY-MM-DD' },
  { k: 'method', label: 'How it was made', hint: 'a model over a national survey', long: true },
  { k: 'terms', label: 'Terms of use', hint: 'public domain, cite the source', long: true },
]
const toDraft = (m: DatasetMetadata | undefined): Draft => {
  const s = m?.source ?? {}
  return {
    row: m?.row ?? '',
    key: m?.key ?? '',
    columns: (m?.columns ?? []).map((c) => ({ name: c.name, meaning: c.meaning ?? '', unit: c.unit ?? '' })),
    source: { publisher: s.publisher ?? '', publisherAbout: s.publisherAbout ?? '', title: s.title ?? '', urls: (s.urls ?? []).join('\n'), coverage: s.coverage ?? '', period: s.period ?? '', fetched: s.fetched ?? '', method: s.method ?? '', terms: s.terms ?? '' },
    caveats: (m?.caveats ?? []).join('\n'),
    assumptions: (m?.estimate?.assumptions ?? []).join('\n'),
  }
}
const draft = ref<Draft>(toDraft(props.metadata))
watch(
  () => props.metadata,
  (m) => {
    if (!editing.value) draft.value = toDraft(m)
  },
)
const linesOf = (t: string) => t.split('\n').map((x) => x.trim()).filter(Boolean)
function send() {
  const d = draft.value
  const m = cleanMetadata({
    row: d.row,
    key: d.key,
    columns: d.columns.filter((c) => c.name.trim()),
    source: { ...d.source, urls: linesOf(d.source.urls) },
    caveats: linesOf(d.caveats),
    ...(props.metadata?.estimate ? { estimate: { ...props.metadata.estimate, assumptions: linesOf(d.assumptions) } } : {}),
  })
  emit('change', m ?? null)
}
const unused = computed(() => props.columns.filter((c) => !draft.value.columns.some((x) => x.name === c)))
function addColumn(name: string) {
  if (!name) return
  draft.value.columns.push({ name, meaning: '', unit: '' })
  send()
}
function removeColumn(i: number) {
  draft.value.columns.splice(i, 1)
  send()
}
function done() {
  send()
  editing.value = false
}
</script>

<template>
  <section class="meta" data-testid="dataset.metadata">
    <div class="head">
      <span class="lbl">Metadata</span>
      <UiButton v-if="!disabled" size="tag" :data-testid="editing ? 'metadata.done' : 'metadata.edit'" @click="editing ? done() : ((draft = toDraft(metadata)), (editing = true))">{{ editing ? 'Done' : 'Edit' }}</UiButton>
    </div>
    <template v-if="!editing">
      <ul v-if="lines.length" class="lines">
        <li v-for="l in lines" :key="l">{{ l }}</li>
      </ul>
      <p v-else class="muted">None yet: what a row is, the columns, the source and its limits.</p>
    </template>
    <div v-else class="form" @change="send">
      <label>What one row is <input v-model="draft.row" placeholder="one per US county" /></label>
      <label>Key <input v-model="draft.key" placeholder="fips (5-digit text)" /></label>

      <fieldset>
        <legend>Columns</legend>
        <div v-for="(c, i) in draft.columns" :key="i" class="col">
          <code>{{ c.name }}</code>
          <input v-model="c.meaning" :aria-label="`${c.name}: meaning`" placeholder="meaning" />
          <input v-model="c.unit" class="unit" :aria-label="`${c.name}: unit`" placeholder="unit" />
          <UiButton size="compact" icon="✕" :aria-label="`Remove ${c.name}`" @click="removeColumn(i)" />
        </div>
        <select v-if="unused.length" aria-label="Add a column" @change.stop="(e) => (addColumn((e.target as HTMLSelectElement).value), ((e.target as HTMLSelectElement).value = ''))">
          <option value="">＋ Column…</option>
          <option v-for="c in unused" :key="c" :value="c">{{ c }}</option>
        </select>
      </fieldset>

      <fieldset>
        <legend>Source</legend>
        <label v-for="f in SOURCE_FIELDS" :key="f.k">
          {{ f.label }}
          <textarea v-if="f.long" v-model="draft.source[f.k]" rows="2" :placeholder="f.hint" />
          <input v-else v-model="draft.source[f.k]" :placeholder="f.hint" />
        </label>
      </fieldset>

      <label>Caveats <textarea v-model="draft.caveats" rows="3" placeholder="one per line: gaps, proxies, estimates" /></label>
      <label v-if="metadata?.estimate">Assumptions <textarea v-model="draft.assumptions" rows="3" placeholder="one per line: what the estimate takes for granted" /></label>
    </div>
  </section>
</template>

<style scoped>
.meta {
  display: grid;
  gap: 0.25rem;
  min-width: 0;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.lbl {
  font-weight: 600;
  font-size: 0.76rem;
}
.lines {
  margin: 0;
  padding-left: 1rem;
  display: grid;
  gap: 0.1rem;
  font-size: 0.76rem;
  overflow-wrap: anywhere;
}
.muted {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.72rem;
}
.form {
  display: grid;
  gap: 0.35rem;
}
fieldset {
  display: grid;
  gap: 0.3rem;
  margin: 0;
  padding: 0.35rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  min-width: 0;
}
legend {
  font-size: 0.72rem;
  color: var(--text-muted);
}
label {
  display: grid;
  gap: 0.15rem;
}
input,
textarea,
select {
  font: inherit;
  padding: 0.3rem;
  font-size: 16px; /* below 16px iOS zooms the page on focus */
  min-width: 0;
}
.col {
  display: grid;
  grid-template-columns: auto 1fr 5rem auto;
  gap: 0.25rem;
  align-items: center;
}
.col code {
  font-size: 0.72rem;
  overflow-wrap: anywhere;
  max-width: 7rem;
}
</style>

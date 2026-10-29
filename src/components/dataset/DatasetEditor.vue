<script setup lang="ts">
// One dataset's panel: name, description, profile and Replace… — for a dataset
// that's here, and for one the workspace points at that this device doesn't
// have (what's known of it, why it's missing, what waits on it; nothing to edit
// but Replace…). Replace… opens the usual add-dataset panel (every source,
// Saved included); what's picked takes this dataset's place everywhere in the
// workspace. Cancel closes it.
import { ref } from 'vue'
import UiButton from '../ui/UiButton.vue'
import AddDatasetPanel from './AddDatasetPanel.vue'
import { vReveal } from '../reveal'
import type { DatasetRecord } from '../../shared/records'
import type { UnavailableDataset } from '../../lib/workspace/workspace'

const props = defineProps<{
  id: string
  /** The dataset, when it's here. */
  dataset?: DatasetRecord
  /** What's known of it, when it isn't here. */
  missing?: { info: UnavailableDataset; waiting: { transforms: number; visualizations: number } }
  /** The transform that writes it, if one does (it can't be replaced: the transform would overwrite it). */
  writtenBy?: string
  /** Open on Replace's source choice (a missing dataset tapped in the graph: replacing is what there is to do). */
  replaceOpen?: boolean
  /** Shows a Done button. */
  closable?: boolean
}>()
const emit = defineEmits<{
  (e: 'update', patch: { name?: string; description?: string }): void
  (e: 'replace', newId: string): void
  (e: 'close'): void
}>()

const replacing = ref(!!props.replaceOpen)
function onAdd(ids: string[]) {
  replacing.value = false
  if (ids[0]) emit('replace', ids[0])
}

const WHY: Record<UnavailableDataset['why'], string> = {
  elsewhere: 'uploaded on another device and kept only there.',
  cloud: "in the cloud, but not reachable from here (not shared with you, or you're signed out).",
  unknown: 'no copy here.',
  builtin: "a built-in table this version of the app doesn't have.",
  output: "made by a transform that couldn't run here.",
}
const n = (k: number, w: string) => `${k.toLocaleString()} ${w}${k === 1 ? '' : 's'}`
const pct = (k: number, of: number) => (of ? `${Math.round((k / of) * 100)}%` : '—')
/** Numbers compact, datetimes as dates. */
const short = (v: unknown) =>
  typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v ?? '').replace(/T00:00:00(\.000)?Z$/, '').slice(0, 19)
</script>

<template>
  <div class="editor" data-no-open :data-testid="missing ? 'missing-dataset' : 'dataset-editor'" :data-name="dataset?.name ?? missing?.info.name">
    <!-- Same fields as for a dataset that's here; a missing one's can't change (there's nothing here to change). -->
    <label>
      Name
      <input type="text" :value="dataset?.name ?? missing?.info.name ?? ''" :disabled="!dataset" @change="emit('update', { name: ($event.target as HTMLInputElement).value })" />
    </label>
    <label>
      Description
      <textarea
        rows="2"
        :value="dataset?.description ?? missing?.info.description ?? ''"
        :disabled="!dataset"
        placeholder="What this data is, where it's from"
        @change="emit('update', { description: ($event.target as HTMLTextAreaElement).value })"
      />
    </label>
    <template v-if="missing">
      <p class="why"><span aria-hidden="true">⚠</span> Not on this device: {{ WHY[missing.info.why] }}<template v-if="missing.info.rows !== undefined"> ({{ n(missing.info.rows, 'row') }})</template></p>
      <p v-if="missing.waiting.transforms || missing.waiting.visualizations" class="muted">
        Waiting on it: {{ [missing.waiting.transforms ? n(missing.waiting.transforms, 'transform') : '', missing.waiting.visualizations ? n(missing.waiting.visualizations, 'visualization') : ''].filter(Boolean).join(' and ') }}.
      </p>
    </template>
    <template v-else-if="dataset">
      <div v-if="dataset.profile" class="profile">
        <div class="lbl">Profile · {{ Math.round(dataset.profile.completeness * 100) }}% of cells filled</div>
        <div class="scroll">
          <table>
            <thead>
              <tr><th>Column</th><th>Type</th><th>Filled</th><th>Distinct</th><th>Range</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in dataset.profile.columns" :key="c.name">
                <td>{{ c.name }}</td>
                <td>{{ c.type }}</td>
                <td>{{ pct(c.filled, dataset.profile.rowCount) }}</td>
                <td>{{ c.distinct.toLocaleString() }}</td>
                <td>{{ c.min === undefined ? '' : `${short(c.min)} – ${short(c.max)}` }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <p v-if="writtenBy" class="muted">Made by the transform "{{ writtenBy }}": to use other data here, change the transform.</p>
    <div v-else class="replace">
      <UiButton v-if="!replacing" data-testid="dataset.replace" size="tag" tone="dataset" icon="⇄" @click="replacing = true">Replace…</UiButton>
      <template v-else>
        <div v-reveal class="lbl">Replace with</div>
        <p class="muted">What you pick takes its place everywhere in this workspace: its transforms read it and its visualizations draw it.</p>
        <AddDatasetPanel :in-workspace="[id]" pick-label="Use" @add="onAdd" @cancel="replacing = false" />
      </template>
    </div>

    <span class="muted">Id <code class="id">{{ id }}</code></span>
    <span v-if="dataset" class="muted">Added {{ new Date(dataset.createdAt).toLocaleString() }}</span>
    <button v-if="closable" class="close" @click="emit('close')">Done</button>
  </div>
</template>

<style scoped>
.editor {
  display: grid;
  gap: 0.35rem;
  font-size: 0.8rem;
  min-width: 0;
}
.why {
  color: var(--danger);
}
p {
  margin: 0;
}
label {
  display: grid;
  gap: 0.15rem;
}
input,
textarea {
  font: inherit;
  padding: 0.3rem;
  font-size: 16px; /* below 16px iOS zooms the page on focus */
}
.replace {
  display: grid;
  gap: 0.35rem;
  justify-items: start;
}
.replace > :deep(*:last-child) {
  justify-self: stretch;
}
.replace > :deep(button:only-child) {
  justify-self: start;
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
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
}
.close {
  justify-self: end;
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.78rem;
}
</style>

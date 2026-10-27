<script setup lang="ts">
// The workspace's datasets: tables in the database, by pointer, as cards in
// an ObjectList. Hold a card (right-click with a mouse) for Explore (a SQL
// window over it, ExploreModal), Edit (rename / describe — a server request — and the profile),
// Copy id (paste it into a transform's input search), Move to remote / local
// storage, Reorder, Remove (out of the workspace — the table stays in the
// database) and Delete (the table itself).
import { ref } from 'vue'
import ObjectList, { type ObjectAction } from '../list/ObjectList.vue'
import ExploreModal from './ExploreModal.vue'
import { request } from '../../client/api'
import { storeOf, type DatasetRecord } from '../../shared/records'

const props = defineProps<{
  datasets: DatasetRecord[]
  vizCount: (id: string) => number
  /** Shown under the graph: no hint. */
  compact?: boolean
  /** Every workspace dataset, usable by name in Explore's SQL (defaults to `datasets`). */
  tables?: DatasetRecord[]
}>()
const emit = defineEmits<{
  (e: 'remove', id: string): void
  /** Delete the dataset from the database (the page confirms and updates the workspace). */
  (e: 'delete', id: string): void
  /** The dataset record changed on the server (moved). */
  (e: 'changed', id: string): void
  (e: 'reorder', ids: string[]): void
  (e: 'update', id: string, patch: { name?: string; description?: string }): void
}>()

const editing = ref<string | null>(null)

const actions = (ds: DatasetRecord): ObjectAction[] => [
  { id: 'explore', icon: '▤', label: 'Explore' },
  { id: 'edit', icon: '✎', label: editing.value === ds.id ? 'Close edit' : 'Edit' },
  { id: 'copy', icon: '⧉', label: 'Copy id' },
  storeOf(ds) === 'local' ? { id: 'move', icon: '⇡', label: 'Move to cloud storage' } : { id: 'move', icon: '⇣', label: 'Move to this device' },
  { id: 'remove', icon: '✕', label: 'Remove from workspace', danger: true },
  { id: 'delete', icon: '⊗', label: 'Delete dataset', danger: true },
]
function onAction(id: string, ds: DatasetRecord) {
  if (id === 'explore') exploring.value = ds
  else if (id === 'edit') editing.value = editing.value === ds.id ? null : ds.id
  else if (id === 'copy') copyId(ds.id)
  else if (id === 'move') move(ds)
  else if (id === 'remove') emit('remove', ds.id)
  else if (id === 'delete') emit('delete', ds.id)
}

// ── move between stores ────────────────────────────────────────────────────

/** A short note on a card (a move's outcome). */
const notes = ref(new Map<string, string>())
async function move(ds: DatasetRecord) {
  const to = storeOf(ds) === 'local' ? 'remote' : 'local'
  const r = await request('moveDataset', { id: ds.id, to })
  notes.value = new Map(notes.value).set(ds.id, r.ok ? `Moved to ${to === 'remote' ? 'cloud storage' : 'this device'} ✓` : r.error.message)
  if (r.ok) emit('changed', ds.id)
}

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

// ── explore: a SQL window over the dataset (and the workspace's others) ───

const exploring = ref<DatasetRecord | null>(null)

const stats = (d: DatasetRecord) => `${plural(d.rowCount, 'row')} · ${plural(d.columns.length, 'column')}`
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—')
/** Numbers compact, datetimes as dates. */
const short = (v: unknown) =>
  typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v ?? '').replace(/T00:00:00(\.000)?Z$/, '').slice(0, 19)
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
</script>

<template>
  <ObjectList
    :items="datasets"
    :item-key="(d) => d.id"
    :item-label="(d) => d.name"
    :actions="actions"
    reorderable
    :hint="compact ? '' : 'Tap and hold a dataset for options.'"
    @action="onAction"
    @open="(ds) => (exploring = ds)"
    @reorder="(ids) => emit('reorder', ids)"
  >
    <template #default="{ item: ds }">
      <div class="title">
        <strong>{{ ds.name }}</strong>
        <span v-if="ds.description" class="desc">{{ ds.description }}</span>
        <span class="muted">
          <span class="store" :class="storeOf(ds)" :title="storeOf(ds) === 'local' ? 'Kept on this device' : 'Kept in cloud storage'">{{ storeOf(ds) === 'local' ? 'Local' : 'Cloud' }}</span>
          {{ stats(ds) }} · {{ ds.origin }}
        </span>
        <span v-if="copied === ds.id" class="copied">Id copied ✓</span>
        <span v-if="notes.get(ds.id)" class="note">
          {{ notes.get(ds.id) }}
          <button class="dismiss" aria-label="Dismiss" @click.stop="notes = new Map([...notes].filter(([k]) => k !== ds.id))">✕</button>
        </span>
      </div>
      <div v-if="editing === ds.id" class="edit" data-no-open>
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
        <button class="close" @click="editing = null">Done</button>
      </div>
            <p class="muted uses">Used by {{ plural(vizCount(ds.id), 'visualization') }}</p>
    </template>
  </ObjectList>
  <ExploreModal v-if="exploring" :dataset="exploring" :tables="props.tables ?? props.datasets" @close="exploring = null" />
</template>

<style scoped>
.copied {
  color: var(--accent-blue);
  font-size: 0.72rem;
}
.store {
  display: inline-block;
  margin-right: 0.2rem;
  padding: 0 0.4rem;
  border: 1px solid var(--border-strong);
  border-radius: 1rem;
  font-size: 0.64rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--text-muted);
}
.store.remote {
  border-color: var(--kind-dataset);
  color: var(--kind-dataset);
}
.note {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  margin-top: 0.2rem;
  font-size: 0.74rem;
  color: var(--warn);
}
.dismiss {
  padding: 0 0.3rem;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 0.7rem;
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
.desc {
  font-size: 0.76rem;
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
.title {
  display: grid;
  min-width: 0;
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
}
.warn {
  margin: 0.25rem 0 0;
  font-size: 0.72rem;
  color: var(--danger);
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
.uses {
  margin: 0.25rem 0 0;
}
</style>

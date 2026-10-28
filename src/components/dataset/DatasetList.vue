<script lang="ts">
/** What the cloud actions on a dataset are. */
export type CloudAction = 'store' | 'save' | 'discard' | 'copy'
</script>

<script setup lang="ts">
// The workspace's datasets: tables in the database, by pointer, as cards in
// an ObjectList. Hold a card (right-click with a mouse) for Explore (a SQL
// window over it, ExploreModal), Edit (rename / describe — a server request — and the profile),
// Copy id (paste it into a transform's input search), the cloud actions (Move
// to cloud storage; for a cloud dataset Make a local copy, and when its rows
// changed here Save dataset / Discard local changes — the page does them),
// Reorder, Remove (out of the workspace — the table stays in the database) and
// Delete (the table itself).
import { ref } from 'vue'
import ObjectList, { type ObjectAction } from '../list/ObjectList.vue'
import ExploreModal from './ExploreModal.vue'
import { changedHere, storeOf, type DatasetRecord } from '../../shared/records'
import { useDetailTarget } from '../detailTarget'
import { vReveal } from '../reveal'
import DatasetEditor from './DatasetEditor.vue'

const props = defineProps<{
  datasets: DatasetRecord[]
  vizCount: (id: string) => number
  /** Shown under the graph: no hint. */
  compact?: boolean
  /** Every workspace dataset, usable by name in Explore's SQL (defaults to `datasets`). */
  tables?: DatasetRecord[]
  /** The transform that writes a dataset, if one does (such a dataset can't be replaced: the transform would overwrite it). */
  writtenBy?: (id: string) => string | undefined
  /** A short note on a dataset's card (a cloud action's outcome), by id. */
  notes?: Map<string, string>
}>()
const emit = defineEmits<{
  (e: 'remove', id: string): void
  /** Delete the dataset from the database (the page confirms and updates the workspace). */
  (e: 'delete', id: string): void
  /** A cloud action on a dataset: store it, save its changes, take the cloud's back, or copy it here. */
  (e: 'cloud', action: CloudAction, id: string): void
  (e: 'dismiss-note', id: string): void
  (e: 'reorder', ids: string[]): void
  (e: 'update', id: string, patch: { name?: string; description?: string }): void
  /** Put another dataset (one here, or a new upload) in this one's place in the workspace. */
  (e: 'replace', id: string, newId: string): void
}>()

const editing = ref<string | null>(null)
/** Desktop setup mode: the editor (and Explore) open in the page's right column. */
const detailTarget = useDetailTarget()

const CLOUD_ACTIONS: Record<CloudAction, ObjectAction> = {
  store: { id: 'store', icon: '⇡', label: 'Move to cloud storage' },
  save: { id: 'save', icon: '⇡', label: 'Save dataset to the cloud' },
  discard: { id: 'discard', icon: '↺', label: 'Discard local changes' },
  copy: { id: 'copy-local', icon: '⇣', label: 'Make a local copy' },
}
const cloudActions = (ds: DatasetRecord): ObjectAction[] =>
  storeOf(ds) === 'local' ? [CLOUD_ACTIONS.store] : changedHere(ds) ? [CLOUD_ACTIONS.save, CLOUD_ACTIONS.discard, CLOUD_ACTIONS.copy] : [CLOUD_ACTIONS.copy]
const actions = (ds: DatasetRecord): ObjectAction[] => [
  { id: 'explore', icon: '▤', label: 'Explore' },
  { id: 'edit', icon: '✎', label: editing.value === ds.id ? 'Close edit' : 'Edit' },
  { id: 'copy', icon: '⧉', label: 'Copy id' },
  ...cloudActions(ds),
  { id: 'remove', icon: '✕', label: 'Remove from workspace', danger: true },
  { id: 'delete', icon: '⊗', label: 'Delete dataset', danger: true },
]
function onAction(id: string, ds: DatasetRecord) {
  if (id === 'explore') exploring.value = ds
  else if (id === 'edit') editing.value = editing.value === ds.id ? null : ds.id
  else if (id === 'copy') copyId(ds.id)
  else if (id === 'store' || id === 'save' || id === 'discard') emit('cloud', id, ds.id)
  else if (id === 'copy-local') emit('cloud', 'copy', ds.id)
  else if (id === 'remove') emit('remove', ds.id)
  else if (id === 'delete') emit('delete', ds.id)
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
          <span
            class="store"
            :class="[storeOf(ds), { changed: changedHere(ds) }]"
            :title="storeOf(ds) === 'local' ? 'Kept on this device' : changedHere(ds) ? 'In cloud storage, with changes made here that aren\'t saved to the cloud yet' : 'Kept in cloud storage (with a copy here)'"
            >{{ storeOf(ds) === 'local' ? 'Local' : changedHere(ds) ? '● Cloud · changed here' : 'Cloud' }}</span
          >
          {{ stats(ds) }} · {{ ds.origin }}
        </span>
        <span v-if="copied === ds.id" class="copied">Id copied ✓</span>
        <span v-if="notes?.get(ds.id)" class="note" :class="{ ok: notes.get(ds.id)!.includes('✓') }">
          {{ notes.get(ds.id) }}
          <button class="dismiss" aria-label="Dismiss" @click.stop="emit('dismiss-note', ds.id)">✕</button>
        </span>
      </div>
      <Teleport defer :to="detailTarget ?? 'body'" :disabled="!!compact || !detailTarget">
      <div v-if="editing === ds.id" v-reveal class="edit" :class="{ aside: detailTarget && !compact }" data-no-open>
        <div v-if="detailTarget && !compact" class="aside-title"><span class="eyebrow">Dataset</span> <strong>{{ ds.name }}</strong></div>
        <DatasetEditor
          :id="ds.id"
          :dataset="ds"
          :written-by="writtenBy?.(ds.id)"
          closable
          @update="(patch) => emit('update', ds.id, patch)"
          @replace="(newId) => emit('replace', ds.id, newId)"
          @close="editing = null"
        />
      </div>
      </Teleport>
            <p class="muted uses">Used by {{ plural(vizCount(ds.id), 'visualization') }}</p>
    </template>
  </ObjectList>
  <ExploreModal v-if="exploring" :dataset="exploring" :tables="props.tables ?? props.datasets" :aside-to="detailTarget" @close="exploring = null" />
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
.store.changed {
  border-color: var(--warn);
  color: var(--warn);
}
.note {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  margin-top: 0.2rem;
  font-size: 0.74rem;
  color: var(--warn);
}
.note.ok {
  color: var(--ok);
}
.dismiss {
  padding: 0 0.3rem;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 0.7rem;
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
.uses {
  margin: 0.25rem 0 0;
}
</style>

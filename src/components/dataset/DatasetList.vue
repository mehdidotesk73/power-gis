<script setup lang="ts">
// Imported datasets: what each holds, how its rows matched, how many
// visualizations use it. Drag ≡ to reorder; Edit renames or describes.
// (Visualizations are added from the Visualizations panel.)
import { ref } from 'vue'
import type { LoadedDataset } from './types'
import { useDragReorder } from './useDragReorder'
import { BOUNDARIES } from '../../lib/dataset/binding'

const props = defineProps<{ datasets: LoadedDataset[]; vizCount: (id: string) => number }>()
const emit = defineEmits<{
  (e: 'zoom', id: string): void
  (e: 'remove', id: string): void
  (e: 'reorder', ids: string[]): void
  (e: 'update', id: string, patch: { name?: string; description?: string }): void
}>()

const listEl = ref<HTMLElement>()
const { dragging, onHandleDown, onHandleMove, onHandleUp } = useDragReorder(
  listEl,
  () => props.datasets.map((d) => d.spec.id),
  (ids) => emit('reorder', ids),
)
const editing = ref<string | null>(null)

function where(ds: LoadedDataset): string {
  const b = ds.spec.binding
  if (b.kind === 'boundary') return `${b.column} → ${BOUNDARIES[b.boundary].split(' (')[0]}`
  if (b.kind === 'latlon') return `${b.lat}, ${b.lon} → points`
  return `${b.column} → shapes`
}

function stats(ds: LoadedDataset): string {
  const n = ds.built.base.features.length
  const rows = [...ds.built.rowsByKey.values()].reduce((a, r) => a + r.length, 0)
  const kind = ds.built.geometryKind === 'point' ? 'points' : ds.built.geometryKind === 'polyline' ? 'lines' : 'regions'
  return `${plural(rows, 'row')} · ${n.toLocaleString()} ${kind} · ${plural(ds.built.columns.length, 'column')}`
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
</script>

<template>
  <ul ref="listEl" class="list">
    <li v-for="ds in datasets" :key="ds.spec.id" :data-id="ds.spec.id" class="ds" :class="{ dragging: dragging === ds.spec.id }">
      <div class="head">
        <span
          v-if="datasets.length > 1"
          class="handle"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          @pointerdown="onHandleDown($event, ds.spec.id)"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
          >≡</span
        >
        <div class="title">
          <strong>{{ ds.spec.name }}</strong>
          <span v-if="ds.meta.description" class="desc">{{ ds.meta.description }}</span>
          <span class="muted">{{ stats(ds) }}</span>
          <span class="muted">{{ where(ds) }} · {{ ds.spec.origin }}</span>
        </div>
        <button class="icon" :class="{ on: editing === ds.spec.id }" title="Rename / describe" @click="editing = editing === ds.spec.id ? null : ds.spec.id">✎</button>
        <button class="icon" title="Zoom to data" @click="emit('zoom', ds.spec.id)">⤢</button>
        <button class="icon" title="Remove dataset and its visualizations" @click="emit('remove', ds.spec.id)">✕</button>
      </div>
      <div v-if="editing === ds.spec.id" class="edit">
        <label>
          Name
          <input type="text" :value="ds.spec.name" @change="emit('update', ds.spec.id, { name: ($event.target as HTMLInputElement).value })" />
        </label>
        <label>
          Description
          <textarea
            rows="2"
            :value="ds.meta.description ?? ''"
            placeholder="What this data is, where it's from"
            @change="emit('update', ds.spec.id, { description: ($event.target as HTMLTextAreaElement).value })"
          />
        </label>
        <span class="muted">Added {{ new Date(ds.meta.createdAt).toLocaleString() }}</span>
      </div>
      <p v-if="ds.built.unmatched" class="warn">
        {{ plural(ds.built.unmatched, 'row') }} had no matching feature (e.g. {{ ds.built.unmatchedSamples.slice(0, 3).join(', ') }})
      </p>
      <p class="muted uses">Used by {{ plural(vizCount(ds.spec.id), 'visualization') }}</p>
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

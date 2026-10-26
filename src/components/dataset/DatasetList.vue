<script setup lang="ts">
// The workspace's datasets: tables in the database, by pointer. Drag ≡ to
// reorder; ✎ renames or describes (a server request). ✕ takes a dataset out of the workspace — the
// table stays in the database. (Visualizations are added from the
// Visualizations panel; how rows map to features is part of each one.)
import { ref } from 'vue'
import { useDragReorder } from './useDragReorder'
import type { DatasetRecord } from '../../shared/records'

const props = defineProps<{ datasets: DatasetRecord[]; vizCount: (id: string) => number }>()
const emit = defineEmits<{
  (e: 'zoom', id: string): void
  (e: 'remove', id: string): void
  (e: 'reorder', ids: string[]): void
  (e: 'update', id: string, patch: { name?: string; description?: string }): void
}>()

const listEl = ref<HTMLElement>()
const { dragging, onHandleDown, onHandleMove, onHandleUp } = useDragReorder(
  listEl,
  () => props.datasets.map((d) => d.id),
  (ids) => emit('reorder', ids),
)
const editing = ref<string | null>(null)
const stats = (d: DatasetRecord) => `${plural(d.rowCount, 'row')} · ${plural(d.columns.length, 'column')}`
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
</script>

<template>
  <ul ref="listEl" class="list">
    <li v-for="ds in datasets" :key="ds.id" :data-id="ds.id" class="ds" :class="{ dragging: dragging === ds.id }">
      <div class="head">
        <span
          v-if="datasets.length > 1"
          class="handle"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          @pointerdown="onHandleDown($event, ds.id)"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
          >≡</span
        >
        <div class="title">
          <strong>{{ ds.name }}</strong>
          <span v-if="ds.description" class="desc">{{ ds.description }}</span>
          <span class="muted">{{ stats(ds) }} · {{ ds.origin }}</span>
        </div>
        <button class="icon" :class="{ on: editing === ds.id }" title="Rename / describe" @click="editing = editing === ds.id ? null : ds.id">✎</button>
        <button class="icon" title="Zoom to data" @click="emit('zoom', ds.id)">⤢</button>
        <button class="icon" title="Take out of the workspace (stays in the database)" @click="emit('remove', ds.id)">✕</button>
      </div>
      <div v-if="editing === ds.id" class="edit">
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
        <span class="muted">Added {{ new Date(ds.createdAt).toLocaleString() }}</span>
      </div>
      <p class="muted uses">Used by {{ plural(vizCount(ds.id), 'visualization') }}</p>
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

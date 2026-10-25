<script setup lang="ts">
// Every layer on the map, from any data source, in one list: show/hide,
// edit, remove. Layers are edited in place in the page's layer list.
import { ref } from 'vue'
import LayerEditor from './LayerEditor.vue'
import type { LoadedDatasource } from './types'
import { AGGREGATIONS } from '../../lib/datasource/aggregate'
import { columnLabel, ROWS, type LayerSpec } from '../../lib/datasource/layer'
import type { LayerData } from '../../lib/schema'

const props = defineProps<{
  layers: LayerSpec[]
  datasources: LoadedDatasource[]
  dataFor: (layer: LayerSpec) => LayerData | null
}>()
const emit = defineEmits<{ (e: 'update', l: LayerSpec): void; (e: 'remove', id: string): void }>()

const editing = ref<string | null>(null)
const dsOf = (l: LayerSpec) => props.datasources.find((d) => d.spec.id === l.datasourceId)

function summary(l: LayerSpec): string {
  const what = l.column === ROWS ? 'row count' : `${columnLabel(l.column)} · ${AGGREGATIONS[l.aggregation].toLowerCase()}`
  return l.kind === 'vector' ? `arrows · ${what}` : what
}
defineExpose({ edit: (id: string) => (editing.value = id) })
</script>

<template>
  <p v-if="!layers.length" class="muted">No layers yet — add one from a data source below.</p>
  <ul class="list">
    <li v-for="l in layers" :key="l.id" class="item">
      <div class="head">
        <label class="name">
          <input v-model="l.visible" type="checkbox" />
          <span>
            {{ l.name }} <span v-if="l.kind === 'vector'" class="tag">➚</span>
            <span class="muted">{{ dsOf(l)?.spec.name }} · {{ summary(l) }}</span>
          </span>
        </label>
        <button class="edit" :class="{ on: editing === l.id }" @click="editing = editing === l.id ? null : l.id">
          {{ editing === l.id ? 'Done' : 'Edit' }}
        </button>
      </div>
      <LayerEditor
        v-if="editing === l.id && dsOf(l) && dataFor(l)"
        :built="dsOf(l)!.built"
        :layer="l"
        :data="dataFor(l)!"
        @update="(n) => emit('update', n)"
        @remove="emit('remove', l.id)"
      />
    </li>
  </ul>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}
.item {
  display: grid;
  gap: 0.4rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px dashed var(--border);
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 0.35rem;
}
.name {
  flex: 1;
  display: flex;
  gap: 0.4rem;
  align-items: flex-start;
  min-width: 0;
}
.name > span {
  display: grid;
  min-width: 0;
}
.tag {
  color: var(--accent-blue);
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
  margin: 0;
}
.edit {
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.74rem;
}
.edit.on {
  border-color: var(--accent-blue);
}
</style>

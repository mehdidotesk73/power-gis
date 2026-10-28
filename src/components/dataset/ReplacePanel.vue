<script setup lang="ts">
// Picks what takes a dataset's place in the workspace: a file to upload, or a
// dataset already here (the add-dataset panel, opened on CSV or Saved).
import { ref } from 'vue'
import UiButton from '../ui/UiButton.vue'
import AddDatasetPanel from './AddDatasetPanel.vue'
import { vReveal } from '../reveal'

// `exclude`: the dataset being replaced (any other dataset here can take its place, workspace ones too).
defineProps<{ exclude: string[] }>()
const emit = defineEmits<{ (e: 'pick', datasetId: string): void; (e: 'cancel'): void }>()

const from = ref<null | 'csv' | 'db'>(null)
function onAdd(ids: string[]) {
  from.value = null
  if (ids[0]) emit('pick', ids[0])
}
</script>

<template>
  <div class="replace">
    <div v-if="!from" class="actions">
      <UiButton size="tag" tone="dataset" icon="⇄" @click="from = 'csv'">Replace with a file…</UiButton>
      <UiButton size="tag" tone="dataset" icon="⇄" @click="from = 'db'">Replace with a dataset…</UiButton>
    </div>
    <div v-else v-reveal class="pick">
      <p class="muted">The replacement takes its place everywhere: transforms read it and visualizations draw it.</p>
      <AddDatasetPanel :key="from" :in-workspace="exclude" :start="from" pick-label="Use" @add="onAdd" @cancel="(from = null), emit('cancel')" />
    </div>
  </div>
</template>

<style scoped>
.replace,
.pick {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.muted {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}
</style>

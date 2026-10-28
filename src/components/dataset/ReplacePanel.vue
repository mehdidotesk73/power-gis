<script setup lang="ts">
// Replace… : one button that opens the add-dataset panel (any source: built-in,
// a file, ArcGIS, or a dataset already here under Saved). What's picked takes
// the dataset's place everywhere in the workspace; Cancel just closes it.
import { ref } from 'vue'
import UiButton from '../ui/UiButton.vue'
import AddDatasetPanel from './AddDatasetPanel.vue'
import { vReveal } from '../reveal'

// `exclude`: the dataset being replaced (any other dataset here can take its place, workspace ones too).
// `startOpen`: open on the source choice straight away (a missing dataset tapped in the graph).
const props = defineProps<{ exclude: string[]; startOpen?: boolean }>()
const emit = defineEmits<{ (e: 'pick', datasetId: string): void }>()

const open = ref(!!props.startOpen)
function onAdd(ids: string[]) {
  open.value = false
  if (ids[0]) emit('pick', ids[0])
}
</script>

<template>
  <div class="replace">
    <UiButton v-if="!open" size="tag" tone="dataset" icon="⇄" @click="open = true">Replace…</UiButton>
    <div v-else v-reveal class="pick">
      <p class="muted">Pick what takes its place everywhere in this workspace: its transforms read it and its visualizations draw it.</p>
      <AddDatasetPanel :in-workspace="exclude" pick-label="Use" @add="onAdd" @cancel="open = false" />
    </div>
  </div>
</template>

<style scoped>
.replace,
.pick {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  align-items: flex-start;
}
.pick {
  align-items: stretch;
}
.muted {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}
</style>

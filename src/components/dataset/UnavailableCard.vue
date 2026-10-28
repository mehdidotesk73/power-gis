<script setup lang="ts">
// A dataset the workspace points at that this device doesn't have: what's
// known of it, what waits on it, and the way out — replace it with a file or
// a dataset that's here (the replacement takes over every pointer to it).
import { ref } from 'vue'
import UiButton from '../ui/UiButton.vue'
import AddDatasetPanel from './AddDatasetPanel.vue'
import { vReveal } from '../reveal'
import type { UnavailableDataset } from '../../lib/workspace/workspace'

const props = defineProps<{
  id: string
  info: UnavailableDataset
  /** What waits on it here. */
  waiting: { transforms: number; visualizations: number }
  inWorkspace: string[]
}>()
const emit = defineEmits<{ (e: 'replace', oldId: string, newId: string): void }>()

const WHY: Record<UnavailableDataset['why'], string> = {
  elsewhere: 'Uploaded on another device and kept only there.',
  cloud: "In the cloud, but not reachable from here (not shared with you, or you're signed out).",
  unknown: 'Not on this device.',
  builtin: "A built-in table this version of the app doesn't have.",
  output: "Made by a transform that couldn't run here.",
}
const replacing = ref<null | 'csv' | 'db'>(null)
const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`

function onAdd(ids: string[]) {
  replacing.value = null
  if (ids[0]) emit('replace', props.id, ids[0])
}
</script>

<template>
  <div class="unavailable">
    <div class="head">
      <span class="mark" aria-hidden="true">⚠</span>
      <strong>{{ info.name }}</strong>
      <span v-if="info.rows !== undefined" class="muted">{{ info.rows.toLocaleString() }} rows</span>
    </div>
    <p class="why">{{ WHY[info.why] }}</p>
    <p v-if="info.description" class="muted">{{ info.description }}</p>
    <p v-if="waiting.transforms || waiting.visualizations" class="muted">
      Waiting on it: {{ [waiting.transforms ? n(waiting.transforms, 'transform') : '', waiting.visualizations ? n(waiting.visualizations, 'visualization') : ''].filter(Boolean).join(' and ') }}.
    </p>
    <div v-if="!replacing" class="actions">
      <UiButton size="tag" tone="dataset" icon="⇄" @click="replacing = 'csv'">Replace with a file…</UiButton>
      <UiButton size="tag" tone="dataset" icon="⇄" @click="replacing = 'db'">Replace with a dataset…</UiButton>
    </div>
    <div v-else v-reveal class="replace">
      <p class="muted">The replacement takes its place everywhere: its transforms read the new one and its visualizations draw it. Columns the SQL expects should match.</p>
      <AddDatasetPanel :key="replacing" :in-workspace="inWorkspace" :start="replacing" @add="onAdd" @cancel="replacing = null" />
    </div>
  </div>
</template>

<style scoped>
.unavailable {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.5rem 0.6rem;
  border: 2px solid var(--danger);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--danger) 8%, var(--bg-elev));
}
.head {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.mark,
.why {
  color: var(--danger);
}
.why,
.muted {
  margin: 0;
  font-size: 0.78rem;
}
.muted {
  color: var(--text-muted);
}
.actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.replace {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
</style>

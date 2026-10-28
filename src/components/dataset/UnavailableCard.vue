<script setup lang="ts">
// A dataset the workspace points at that this device doesn't have: what's
// known of it, what waits on it, and the way out — replace it with a file or
// a dataset that's here (the replacement takes over every pointer to it).
import ReplacePanel from './ReplacePanel.vue'
import type { UnavailableDataset } from '../../lib/workspace/workspace'

const props = defineProps<{
  id: string
  info: UnavailableDataset
  /** What waits on it here. */
  waiting: { transforms: number; visualizations: number }
  /** Open on Replace's source choice (tapped in the graph: replacing is all there is to do). */
  replaceOpen?: boolean
}>()
const emit = defineEmits<{ (e: 'replace', oldId: string, newId: string): void }>()

const WHY: Record<UnavailableDataset['why'], string> = {
  elsewhere: 'Uploaded on another device and kept only there.',
  cloud: "In the cloud, but not reachable from here (not shared with you, or you're signed out).",
  unknown: 'Not on this device.',
  builtin: "A built-in table this version of the app doesn't have.",
  output: "Made by a transform that couldn't run here.",
}
const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`
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
    <ReplacePanel :key="id" :exclude="[id]" :start-open="replaceOpen" @pick="(newId) => emit('replace', props.id, newId)" />
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
</style>

<script setup lang="ts">
// The editing tools over the graph and the lists: one ✎ button that opens to
// Select (phones: taps then pick), Delete (what's picked), Undo, Redo and ✕
// (closes them, ending Select). With a mouse, Ctrl/⌘- or Shift-click picks,
// Delete deletes, Ctrl/⌘+Z undoes, Shift+Ctrl/⌘+Z or Ctrl+Y redoes, menu or not.
import { ref } from 'vue'
import UiButton from './ui/UiButton.vue'

const props = defineProps<{ selecting: boolean; count: number; canUndo: boolean; canRedo: boolean }>()
const emit = defineEmits<{
  (e: 'select', on: boolean): void
  (e: 'clear'): void
  (e: 'delete'): void
  (e: 'undo'): void
  (e: 'redo'): void
}>()

const open = ref(false)
function close() {
  open.value = false
  if (props.selecting) emit('select', false)
  if (props.count) emit('clear')
}
</script>

<template>
  <div class="tools" :class="{ open: open || count > 0 }" role="toolbar" aria-label="Edit tools" @pointerdown.stop @touchstart.stop>
    <template v-if="open || count > 0">
      <UiButton
        data-testid="tools.select"
        size="compact"
        :active="selecting"
        :aria-pressed="selecting"
        title="Pick several (or Ctrl/⌘- or Shift-click them), then Delete"
        @click="emit('select', !selecting)"
        >{{ selecting ? 'Done' : 'Select' }}</UiButton
      >
      <UiButton data-testid="tools.delete" size="compact" tone="danger" :disabled="!count" title="Take the picked items out of the workspace (Delete)" @click="emit('delete')"
        >Delete{{ count ? ` ${count}` : '' }}</UiButton
      >
      <UiButton data-testid="undo" size="compact" icon="↶" :disabled="!canUndo" aria-label="Undo" title="Undo (Ctrl/⌘+Z)" @click="emit('undo')" />
      <UiButton data-testid="redo" size="compact" icon="↷" :disabled="!canRedo" aria-label="Redo" title="Redo (Shift+Ctrl/⌘+Z or Ctrl+Y)" @click="emit('redo')" />
      <UiButton data-testid="tools.close" size="compact" icon="✕" aria-label="Close the edit tools" title="Close (ends Select)" @click="close" />
    </template>
    <UiButton v-else data-testid="tools.open" size="compact" icon="✎" aria-label="Edit tools: select, delete, undo, redo" title="Select, delete, undo, redo" @click="open = true" />
  </div>
</template>

<style scoped>
.tools {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
  padding: 0.2rem;
  border-radius: var(--radius);
}
.tools.open {
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 94%, transparent);
  box-shadow: var(--shadow);
}
</style>

<script setup lang="ts">
// The editing tools over the graph and the lists: one ✎ button that opens to
// Select (phones: taps then pick), Delete (what's picked), Undo, Redo and ✕
// (closes them, ending Select). With a mouse, Ctrl/⌘- or Shift-click picks,
// Delete deletes, Ctrl/⌘+Z undoes, Shift+Ctrl/⌘+Z or Ctrl+Y redoes, menu or not.
import { computed, ref } from 'vue'
import UiButton from './ui/UiButton.vue'

const props = defineProps<{
  selecting: boolean
  count: number
  canUndo: boolean
  canRedo: boolean
  /** `bar`: one thin full-width row (the list view), the note inline; else a small floating group (the graph). */
  bar?: boolean
  /** One line beside the buttons in `bar` (what the last Delete did, or how to pick). */
  note?: string
}>()
const emit = defineEmits<{
  (e: 'select', on: boolean): void
  (e: 'clear'): void
  (e: 'delete'): void
  (e: 'undo'): void
  (e: 'redo'): void
}>()

const open = ref(false)
/** Open: by the user, while something is picked, or (bar) while there's a note to read beside ↶. */
const shown = computed(() => open.value || props.count > 0 || (!!props.bar && !!props.note))
function close() {
  open.value = false
  if (props.selecting) emit('select', false)
  emit('clear')
}
</script>

<template>
  <div class="tools" :class="{ open: shown, bar }" role="toolbar" aria-label="Edit tools" @pointerdown.stop @touchstart.stop>
    <template v-if="shown">
      <UiButton
        data-testid="tools.select"
        :size="bar ? 'tag' : 'compact'"
        :active="selecting"
        :aria-pressed="selecting"
        title="Pick several (or Ctrl/⌘- or Shift-click them), then Delete"
        @click="emit('select', !selecting)"
        >{{ selecting ? 'Done' : 'Select' }}</UiButton
      >
      <UiButton data-testid="tools.delete" :size="bar ? 'tag' : 'compact'" tone="danger" :disabled="!count" title="Take the picked items out of the workspace (Delete)" @click="emit('delete')"
        >Delete{{ count ? ` ${count}` : '' }}</UiButton
      >
      <UiButton data-testid="undo" :size="bar ? 'tag' : 'compact'" icon="↶" :disabled="!canUndo" aria-label="Undo" title="Undo (Ctrl/⌘+Z)" @click="emit('undo')" />
      <UiButton data-testid="redo" :size="bar ? 'tag' : 'compact'" icon="↷" :disabled="!canRedo" aria-label="Redo" title="Redo (Shift+Ctrl/⌘+Z or Ctrl+Y)" @click="emit('redo')" />
      <span v-if="bar && note" class="note" role="status">{{ note }}</span>
      <UiButton data-testid="tools.close" :size="bar ? 'tag' : 'compact'" icon="✕" aria-label="Close the edit tools" title="Close (ends Select)" @click="close" />
    </template>
    <button v-else-if="bar" data-testid="tools.open" class="bar-open" aria-label="Edit tools: select, delete, undo, redo" @click="open = true">
      <span aria-hidden="true">✎</span> Select · Delete · Undo
    </button>
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
.tools.bar {
  display: flex;
  flex-wrap: nowrap;
  width: 100%;
  padding: 0;
  gap: 0.25rem;
}
.tools.bar.open {
  padding: 0.15rem;
  box-shadow: none;
}
.bar-open {
  flex: 1;
  min-height: 1.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
.note {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.74rem;
  color: var(--text-muted);
}
.tools.bar .note + :deep(button),
.tools.bar :deep(button:last-child) {
  margin-left: auto;
}
.tools.open {
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 94%, transparent);
  box-shadow: var(--shadow);
}
</style>

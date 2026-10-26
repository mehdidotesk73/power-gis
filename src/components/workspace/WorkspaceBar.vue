<script setup lang="ts">
// The workspace's name and save state. Edits are a draft (kept on this
// device across reloads) until Save sends them to the server. The file
// menu downloads or loads the workspace as a file of pointers and settings.
import { ref } from 'vue'

defineProps<{ name: string; dirty: boolean; saving: boolean; message: string }>()
const emit = defineEmits<{
  (e: 'save'): void
  (e: 'revert'): void
  (e: 'rename', name: string): void
  (e: 'download'): void
  (e: 'load', file: File): void
  (e: 'reset'): void
}>()

const menu = ref(false)
const fileInput = ref<HTMLInputElement>()
function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  menu.value = false
  if (f) emit('load', f)
}
const pick = (what: 'download' | 'reset') => {
  menu.value = false
  if (what === 'download') emit('download')
  else emit('reset')
}
</script>

<template>
  <div class="bar">
    <div class="top">
      <input
        class="name"
        :value="name"
        aria-label="Workspace name"
        @change="emit('rename', ($event.target as HTMLInputElement).value)"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
      <button class="save" :disabled="!dirty || saving" @click="emit('save')">{{ saving ? 'Saving…' : dirty ? 'Save' : 'Saved' }}</button>
      <button class="more" aria-label="Workspace menu" :aria-expanded="menu" @click="menu = !menu">⋯</button>
    </div>
    <div class="state">
      <span v-if="dirty" class="dot">● Unsaved changes</span>
      <span v-else class="muted">All changes saved</span>
      <button v-if="dirty && !saving" class="link" @click="emit('revert')">Discard</button>
    </div>
    <div v-if="menu" class="menu">
      <button @click="pick('download')">⤓ Download workspace file</button>
      <button @click="fileInput?.click()">⤒ Load workspace file…</button>
      <button class="danger" @click="pick('reset')">↺ Reset to the default map</button>
      <p class="muted">The file holds which datasets the workspace uses and its visualizations — not the data itself.</p>
    </div>
    <input ref="fileInput" class="hidden" type="file" accept=".json,application/json" @change="onFile" />
    <p v-if="message" class="msg">{{ message }}</p>
  </div>
</template>

<style scoped>
.bar {
  min-width: 0;
  display: grid;
  gap: 0.3rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-elev);
}
.top {
  display: flex;
  gap: 0.35rem;
  align-items: center;
}
.name {
  flex: 1;
  min-width: 0;
  width: 0; /* let flex size it, not the input's default ~20 characters */
  font: inherit;
  font-weight: 600;
  font-size: 16px; /* below 16px iOS zooms on focus */
  padding: 0.25rem 0.35rem;
  border: 1px solid transparent;
  border-radius: 0.3rem;
  background: none;
  color: var(--text);
}
.name:hover,
.name:focus {
  border-color: var(--border);
}
.save {
  padding: 0.35rem 0.8rem;
  border: 1px solid var(--accent-blue);
  border-radius: 0.35rem;
  background: var(--accent-blue);
  color: var(--on-accent);
  font-weight: 600;
  font-size: 0.85rem;
}
.save:disabled {
  background: none;
  color: var(--text-muted);
  border-color: var(--border);
  font-weight: 400;
}
.more {
  padding: 0.3rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: none;
  color: var(--text);
}
.state {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.74rem;
}
.dot {
  color: var(--warn);
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
  margin: 0;
}
.link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent-blue);
  font-size: inherit;
  text-decoration: underline;
}
.menu {
  display: grid;
  gap: 0.25rem;
  padding-top: 0.3rem;
  border-top: 1px dashed var(--border);
}
.menu button {
  text-align: left;
  padding: 0.4rem 0.3rem;
  border: none;
  background: none;
  color: var(--text);
  font-size: 0.85rem;
}
.menu .danger {
  color: var(--danger);
}
.hidden {
  display: none;
}
.msg {
  margin: 0;
  font-size: 0.74rem;
  color: var(--text-muted);
}
</style>

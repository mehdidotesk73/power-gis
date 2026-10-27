<script setup lang="ts">
// The workspace control in the header: a Workspace button (amber with a ●
// while there are unsaved changes) that drops down a panel with the name,
// what the workspace holds, Save / Discard, and the file actions. Edits are
// a draft (kept on this device across reloads) until Save sends them to the
// server; a workspace file holds pointers and settings, never rows. The same
// JSON can be copied to the clipboard and pasted back (Paste opens a box,
// filled from the clipboard where the browser allows; replace it if wrong).
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  name: string
  dirty: boolean
  saving: boolean
  message: string
  counts: { datasets: number; transforms: number; visualizations: number }
}>()
const emit = defineEmits<{
  (e: 'save'): void
  (e: 'revert'): void
  (e: 'rename', name: string): void
  (e: 'download'): void
  (e: 'load', file: File): void
  (e: 'copy'): void
  (e: 'paste', text: string): void
  (e: 'reset'): void
}>()

const open = ref(false)
const root = ref<HTMLElement>()
const nameEl = ref<HTMLInputElement>()
const fileInput = ref<HTMLInputElement>()

// A message (a failed save, a loaded file's report) opens the panel so it's seen.
watch(
  () => props.message,
  (m) => {
    if (m) open.value = true
  },
)
function toggle() {
  open.value = !open.value
}
function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (f) emit('load', f)
}
function rename(e: Event) {
  const v = (e.target as HTMLInputElement).value.trim()
  if (v && v !== props.name) emit('rename', v)
}
// ── paste a workspace ──────────────────────────────────────────────────────

const pasting = ref(false)
const pasteText = ref('')
const pasteBox = ref<HTMLTextAreaElement>()
async function startPaste() {
  pasting.value = true
  pasteText.value = ''
  // Fill the box from the clipboard (iOS asks with a small Paste bubble; dismissing it leaves the box empty).
  try {
    pasteText.value = await navigator.clipboard.readText()
  } catch {
    // No permission or no clipboard API: the user pastes by hand.
  }
  await nextTick()
  pasteBox.value?.focus()
}
function loadPasted() {
  const text = pasteText.value.trim()
  if (!text) return
  pasting.value = false
  emit('paste', text)
}

async function editName() {
  await nextTick()
  nameEl.value?.focus()
  nameEl.value?.select()
}

// Close on Escape or a tap outside.
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (open.value = false)
const onDown = (e: PointerEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onDown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onDown, true)
})
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
</script>

<template>
  <div ref="root" class="ws">
    <button
      class="ws-btn"
      :class="{ dirty }"
      :aria-expanded="open"
      aria-haspopup="dialog"
      :title="dirty ? `${name} — unsaved changes` : name"
      @click="toggle"
    >
      <span v-if="dirty" class="dot" aria-hidden="true">●</span>
      <span>Workspace</span>
      <span class="caret" aria-hidden="true">▾</span>
    </button>

    <div v-if="open" class="panel" role="dialog" aria-label="Workspace">
      <div class="head">
        <span class="eyebrow">Workspace</span>
        <input
          ref="nameEl"
          class="name"
          :value="name"
          aria-label="Workspace name"
          @change="rename"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
        <button class="icon" aria-label="Rename" title="Rename" @click="editName">✎</button>
      </div>
      <p class="holds">
        {{ plural(counts.datasets, 'dataset') }} · {{ plural(counts.transforms, 'transform') }} · {{ plural(counts.visualizations, 'visualization') }}
      </p>

      <div class="state" :class="{ dirty }">
        <span v-if="dirty">● Unsaved changes — kept on this device until you save</span>
        <span v-else>✓ All changes saved</span>
      </div>
      <div class="row">
        <button class="btn primary" :disabled="!dirty || saving" @click="emit('save')">{{ saving ? 'Saving…' : 'Save' }}</button>
        <button class="btn" :disabled="!dirty || saving" @click="emit('revert')">Discard changes</button>
      </div>

      <div class="file">
        <span class="eyebrow">File</span>
        <button class="item" @click="emit('download')">⤓ Download workspace file</button>
        <button class="item" @click="fileInput?.click()">⤒ Load workspace file…</button>
        <button class="item" @click="emit('copy')">⧉ Copy workspace</button>
        <button class="item" :aria-expanded="pasting" @click="pasting ? (pasting = false) : startPaste()">⎘ Paste workspace…</button>
        <div v-if="pasting" class="paste">
          <textarea
            ref="pasteBox"
            v-model="pasteText"
            rows="5"
            placeholder="Paste a copied workspace (its JSON) here"
            aria-label="Workspace JSON"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
          />
          <div class="row">
            <button class="btn" @click="pasteText = ''">Clear</button>
            <button class="btn" @click="pasting = false">Cancel</button>
            <button class="btn primary" :disabled="!pasteText.trim()" @click="loadPasted">Load</button>
          </div>
        </div>
        <button class="item danger" @click="emit('reset')">↺ Reset to the default map</button>
        <p class="note">A workspace file (or a copied workspace) holds which datasets it uses, its transforms and its visualizations — not the data itself.</p>
      </div>
      <p v-if="message" class="msg">{{ message }}</p>
      <input ref="fileInput" class="hidden" type="file" accept=".json,application/json" @change="onFile" />
    </div>
  </div>
</template>

<style scoped>
.ws {
  position: relative;
}
.ws-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-elev-2);
  color: var(--text-muted);
  font-size: 0.78rem;
  white-space: nowrap;
}
.ws-btn:hover,
.ws-btn[aria-expanded='true'] {
  color: var(--text);
  border-color: var(--accent-blue);
}
.ws-btn.dirty {
  color: var(--warn);
  border-color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, var(--bg-elev-2));
}
.dot {
  font-size: 0.6rem;
}
.caret {
  font-size: 0.6rem;
  opacity: 0.8;
}
.panel {
  position: absolute;
  z-index: 60;
  top: calc(100% + 0.4rem);
  right: 0;
  width: min(22rem, calc(100vw - 1.5rem));
  display: grid;
  gap: 0.6rem;
  padding: 0.75rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-elev);
  box-shadow: var(--shadow);
  text-align: left;
}
/* Phones: a sheet across the screen under the header, not a dropdown that spills off the left. */
@media (max-width: 30rem) {
  .panel {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 3.4rem);
    left: max(0.75rem, env(safe-area-inset-left, 0px));
    right: max(0.75rem, env(safe-area-inset-right, 0px));
    width: auto;
    max-height: calc(100svh - 5rem);
    overflow: auto;
  }
}
.head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.1rem 0.35rem;
}
.eyebrow {
  grid-column: 1 / -1;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.name {
  min-width: 0;
  width: 100%;
  padding: 0.2rem 0.35rem;
  margin-left: -0.35rem;
  border: 1px solid transparent;
  border-radius: 0.3rem;
  background: none;
  color: var(--text);
  font-size: 1.05rem; /* ≥16px: iOS doesn't zoom on focus */
  font-weight: 650;
}
.name:hover,
.name:focus {
  border-color: var(--border);
  background: var(--bg-input);
}
.icon {
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-elev-2);
  color: var(--text-muted);
}
.holds {
  margin: -0.35rem 0 0;
  font-size: 0.76rem;
  color: var(--text-muted);
}
.state {
  font-size: 0.78rem;
  color: var(--ok);
}
.state.dirty {
  color: var(--warn);
}
.row {
  display: flex;
  gap: 0.4rem;
}
.btn {
  flex: 1;
  min-height: 2.2rem;
  border: 1px solid var(--border-strong);
  border-radius: 0.4rem;
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 0.82rem;
}
.btn.primary:not(:disabled) {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: var(--on-accent);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.5;
}
.file {
  display: grid;
  gap: 0.15rem;
  padding-top: 0.55rem;
  border-top: 1px solid var(--border);
}
.item {
  text-align: left;
  padding: 0.45rem 0.4rem;
  border: none;
  border-radius: 0.35rem;
  background: none;
  color: var(--text);
  font-size: 0.84rem;
}
.item:hover {
  background: color-mix(in srgb, var(--accent-blue) 16%, transparent);
}
.item.danger {
  color: var(--danger);
}
.item.danger:hover {
  background: var(--danger-bg);
}
.paste {
  display: grid;
  gap: 0.35rem;
  padding: 0.2rem 0.4rem 0.4rem;
}
.paste textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 0.4rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 16px; /* below 16px iOS zooms on focus */
}
.btn.primary:disabled {
  opacity: 0.5;
}
.note {
  margin: 0.2rem 0 0;
  font-size: 0.72rem;
  color: var(--text-muted);
}
.msg {
  margin: 0;
  font-size: 0.76rem;
  color: var(--warn);
}
.hidden {
  display: none;
}
</style>

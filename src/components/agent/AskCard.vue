<script setup lang="ts">
// A question from the assistant (ask_user, and the scout / scraper approval):
// the question, optional details, the fields it composed — a text box (filled
// in for review when it drafted something), a single or multiple choice with
// an optional answer of the user's own — and its buttons. Once answered, the
// card shows the answer in place. The form itself is lib/agent/form.ts.
import { computed, reactive } from 'vue'
import UiButton from '../ui/UiButton.vue'
import { fieldValue, initialValues, missingRequired, type Form, type FormAnswer, type FormField } from '../../lib/agent/form'

const props = defineProps<{ form: Form; answer?: FormAnswer }>()
const emit = defineEmits<{ (e: 'answer', a: FormAnswer): void }>()

const values = reactive(initialValues(props.form))
/** Each choice's own answer (when the field allows one). */
const others = reactive<Record<string, string>>(Object.fromEntries(props.form.fields.map((f) => [f.id, ''])))
/** A single choice whose own answer is picked (instead of an option). */
const ownPicked = reactive<Record<string, boolean>>({})

const final = () => Object.fromEntries(props.form.fields.map((f) => [f.id, fieldValue(f, ownPicked[f.id] ? [] : values[f.id], others[f.id])]))
const missing = computed(() => missingRequired(props.form, final()))

function pick(f: FormField, option: string) {
  if (f.kind !== 'choice') return
  if (f.multiple) {
    const now = values[f.id] as string[]
    values[f.id] = now.includes(option) ? now.filter((o) => o !== option) : [...now, option]
  } else {
    values[f.id] = [option]
    ownPicked[f.id] = false
  }
}
const isPicked = (f: FormField, option: string) => (values[f.id] as string[]).includes(option)
/** Typing an own answer picks it (a single choice then drops its option). */
function typeOther(f: FormField, text: string) {
  others[f.id] = text
  if (f.kind === 'choice' && !f.multiple && text.trim()) ownPicked[f.id] = true
}
/** The own answer's box: a single choice picks it; a multiple choice unticked clears it. */
function toggleOwn(f: FormField) {
  if (f.kind !== 'choice') return
  if (!f.multiple) ownPicked[f.id] = true
  else if (others[f.id].trim()) others[f.id] = ''
}
const rows = (text: string) => Math.min(12, Math.max(3, text.split('\n').length + 1))

function press(button: string, i: number) {
  if (i === 0 && missing.value.length) return
  emit('answer', { button, values: final() })
}
/** How a value reads once answered. */
const shown = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : (v ?? ''))
</script>

<template>
  <div class="ask" :class="{ done: answer }" data-testid="ask-card">
    <p class="q">{{ form.question }}</p>
    <p v-if="form.details" class="details">{{ form.details }}</p>

    <template v-if="!answer">
      <div v-for="f in form.fields" :key="f.id" class="field">
        <label v-if="f.kind === 'text'" class="label" :for="`ask-${f.id}`">{{ f.label }}<span v-if="f.required" class="req" aria-hidden="true"> *</span></label>
        <span v-else class="label">{{ f.label }}<span v-if="f.required" class="req" aria-hidden="true"> *</span><span class="hint">{{ f.multiple ? ' · any number' : '' }}</span></span>

        <template v-if="f.kind === 'text'">
          <textarea v-if="f.multiline" :id="`ask-${f.id}`" v-model="values[f.id] as string" :rows="rows(values[f.id] as string)" :placeholder="f.placeholder" />
          <input v-else :id="`ask-${f.id}`" v-model="values[f.id] as string" type="text" :placeholder="f.placeholder" autocomplete="off" />
        </template>

        <div v-else class="options" :role="f.multiple ? 'group' : 'radiogroup'" :aria-label="f.label">
          <label v-for="o in f.options" :key="o" class="option">
            <input :type="f.multiple ? 'checkbox' : 'radio'" :name="`ask-${f.id}`" :checked="isPicked(f, o) && !ownPicked[f.id]" @change="pick(f, o)" />
            <span>{{ o }}</span>
          </label>
          <label v-if="f.other" class="option own">
            <input
              :type="f.multiple ? 'checkbox' : 'radio'"
              :name="`ask-${f.id}`"
              :checked="f.multiple ? !!others[f.id].trim() : !!ownPicked[f.id]"
              aria-label="Your own answer"
              @change="toggleOwn(f)"
            />
            <input type="text" :value="others[f.id]" placeholder="Your own…" autocomplete="off" @input="typeOther(f, ($event.target as HTMLInputElement).value)" />
          </label>
        </div>
      </div>

      <p v-if="missing.length" class="hint">Needed for “{{ form.buttons[0] }}”: {{ missing.join(', ') }}</p>
      <div class="buttons">
        <UiButton
          v-for="(b, i) in form.buttons"
          :key="b"
          size="compact"
          :tone="i === 0 ? 'primary' : 'neutral'"
          :disabled="i === 0 && missing.length > 0"
          :data-testid="`ask.button-${i}`"
          @click="press(b, i)"
          >{{ b }}</UiButton
        >
      </div>
    </template>

    <div v-else class="answered">
      <p class="pressed" :class="{ main: answer.button === form.buttons[0] }">{{ answer.button === form.buttons[0] ? '✓' : '→' }} {{ answer.button }}</p>
      <template v-for="f in form.fields" :key="f.id">
        <details v-if="f.kind === 'text' && f.multiline && shown(answer.values[f.id])" class="value">
          <summary>{{ f.label }}</summary>
          <p class="long">{{ shown(answer.values[f.id]) }}</p>
        </details>
        <p v-else-if="shown(answer.values[f.id])" class="value"><span class="label">{{ f.label }}:</span> {{ shown(answer.values[f.id]) }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ask {
  display: grid;
  gap: 0.5rem;
  padding: 0.55rem 0.6rem;
  border: 1px solid var(--accent-blue);
  border-radius: 0.6rem;
  background: color-mix(in srgb, var(--accent-blue) 8%, var(--bg-elev-2));
}
.ask.done {
  gap: 0.3rem;
  border-color: var(--border);
  background: var(--bg-elev-2);
}
p {
  margin: 0;
}
.q {
  font-weight: 600;
}
.details,
.long {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text-muted);
}
.field {
  display: grid;
  gap: 0.25rem;
}
.label {
  font-size: var(--chat-fs-sm);
  color: var(--text-muted);
}
.req {
  color: var(--warn);
}
.hint {
  font-size: var(--chat-fs-sm);
  color: var(--text-muted);
}
input[type='text'],
textarea {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0.35rem 0.45rem;
  font: inherit;
  line-height: 1.4;
}
textarea {
  resize: vertical;
}
.options {
  display: grid;
  gap: 0.15rem;
}
.option {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 2rem; /* tappable */
  cursor: pointer;
}
.option input[type='radio'],
.option input[type='checkbox'] {
  flex: none;
  margin: 0;
  accent-color: var(--accent-blue);
}
.option.own input[type='text'] {
  flex: 1;
}
.buttons {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.4rem;
}
.answered {
  display: grid;
  gap: 0.2rem;
}
.pressed {
  color: var(--text-muted);
}
.pressed.main {
  color: var(--ok);
}
.value {
  overflow-wrap: anywhere;
}
.value summary {
  cursor: pointer;
  font-size: var(--chat-fs-sm);
  color: var(--text-muted);
}
</style>

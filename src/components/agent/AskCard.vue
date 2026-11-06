<script setup lang="ts">
// A question card (lib/agent/form.ts): a title and context, then 1–3 questions —
// each framed (the question, why it's asked), its controls (an editable answer,
// radio buttons with an optional Neither, checkboxes), a folded comments box —
// and one pair of buttons answering them all (an exchange may add Revise with my
// notes between them). A card without questions is a plain yes / no, with one
// comments box. Once answered, the card shows the answers in place.
import { computed, reactive, ref } from 'vue'
import UiButton from '../ui/UiButton.vue'
import { cardAnswer, initialState, missingRequired, NEITHER, REVISE, type Card, type CardAnswer, type Question } from '../../lib/agent/form'

const props = defineProps<{ card: Card; answer?: CardAnswer }>()
const emit = defineEmits<{ (e: 'answer', a: CardAnswer): void }>()

const state = reactive(initialState(props.card))
/** Which comments boxes are open (folded until tapped, or until Neither is picked). */
const open = reactive<Record<string, boolean>>({})
const cardComments = ref('')
const missing = computed(() => missingRequired(props.card, state))

function pickOne(q: Question, option: string) {
  state[q.id].choice = option
  if (option === NEITHER) open[q.id] = true // Neither is said in the comments
}
function toggle(q: Question, option: string) {
  const now = state[q.id].choices
  state[q.id].choices = now.includes(option) ? now.filter((o) => o !== option) : [...now, option]
}
const rows = (text: string) => Math.min(14, Math.max(3, text.split('\n').length + 1))

/** The buttons: the pair, with Revise between them on an exchange that allows it. */
/** Notes written anywhere on the card (each question's comments, or the card's own). */
const hasNotes = computed(() => !!cardComments.value.trim() || props.card.questions.some((q) => !!state[q.id]?.comments?.trim()))
const buttons = computed(() => (props.card.revise ? [props.card.buttons[0], REVISE, props.card.buttons[1]] : [...props.card.buttons]))
function press(button: string) {
  if (button === props.card.buttons[0] && missing.value.length) return
  emit('answer', cardAnswer(props.card, state, button, cardComments.value))
}

/** How a reply reads once answered. */
function said(q: Question): string {
  const r = props.answer?.replies[q.id]
  if (!r) return ''
  if (r.kind === 'answer') return r.edited ? 'edited' : 'as proposed'
  if (r.kind === 'one') return r.neither ? 'Neither' : (r.choice ?? '—')
  return r.choices.join(', ') || 'none'
}
const editedText = (q: Question) => {
  const r = props.answer?.replies[q.id]
  return r?.kind === 'answer' && r.edited ? (r.text ?? '') : ''
}
</script>

<template>
  <div class="ask" :class="{ done: answer }" data-testid="ask-card">
    <p class="q">{{ card.title }}</p>
    <p v-if="card.context" class="details">{{ card.context }}</p>

    <template v-if="!answer">
      <section v-for="(q, i) in card.questions" :key="q.id" class="question" :data-testid="`ask.q${i + 1}`">
        <p class="qq">
          <span v-if="card.questions.length > 1" class="num">{{ i + 1 }}.</span> {{ q.question }}<span v-if="q.required" class="req" aria-hidden="true"> *</span>
        </p>
        <p v-if="q.why" class="why">{{ q.why }}</p>

        <textarea v-if="q.kind === 'answer'" v-model="state[q.id].text" :aria-label="q.question" :rows="rows(state[q.id].text)" />

        <div v-else-if="q.kind === 'one'" class="options" role="radiogroup" :aria-label="q.question">
          <label v-for="o in [...q.options, ...(q.neither ? [NEITHER] : [])]" :key="o" class="option" :class="{ neither: o === NEITHER }">
            <input type="radio" :name="`ask-${q.id}-${card.title}`" :checked="state[q.id].choice === o" @change="pickOne(q, o)" />
            <span>{{ o }}<span v-if="o === q.recommended" class="rec"> (recommended)</span></span>
          </label>
        </div>

        <div v-else class="options" role="group" :aria-label="q.question">
          <label v-for="o in q.options" :key="o" class="option">
            <input type="checkbox" :checked="state[q.id].choices.includes(o)" @change="toggle(q, o)" />
            <span>{{ o }}</span>
          </label>
        </div>

        <textarea
          v-if="open[q.id] || state[q.id].comments"
          v-model="state[q.id].comments"
          class="comments"
          rows="2"
          :aria-label="`Comments: ${q.question}`"
          :placeholder="state[q.id].choice === NEITHER ? 'Neither: say what instead' : 'Comments (optional)'"
        />
        <button v-else class="add-comment" type="button" :data-testid="`ask.comment-${i + 1}`" @click="open[q.id] = true">＋ Comment</button>
      </section>

      <textarea v-if="!card.questions.length" v-model="cardComments" class="comments" rows="2" aria-label="Comments" placeholder="Comments (optional)" />

      <p v-if="card.revise && hasNotes" class="hint notes" data-testid="ask.notes-hint">
        You wrote notes: <b>{{ REVISE }}</b> has it redraft from them first; <b>{{ card.buttons[0] }}</b> goes ahead with them.
      </p>
      <p v-if="missing.length" class="hint">Needed for “{{ card.buttons[0] }}”: {{ missing.join(' · ') }}</p>
      <div class="buttons">
        <UiButton
          v-for="(b, i) in buttons"
          :key="b"
          size="compact"
          :tone="i === 0 ? 'primary' : 'neutral'"
          :disabled="i === 0 && missing.length > 0"
          :data-testid="b === REVISE ? 'ask.revise' : `ask.button-${i === 0 ? 0 : 1}`"
          @click="press(b)"
          >{{ b }}</UiButton
        >
      </div>
    </template>

    <div v-else class="answered">
      <p class="pressed" :class="{ main: answer.button === card.buttons[0] }">{{ answer.button === card.buttons[0] ? '✓' : '→' }} {{ answer.button }}</p>
      <template v-for="q in card.questions" :key="q.id">
        <details v-if="editedText(q)" class="value">
          <summary>{{ q.question }}: edited</summary>
          <p class="long">{{ editedText(q) }}</p>
        </details>
        <p v-else class="value"><span class="label">{{ q.question }}:</span> {{ said(q) }}</p>
        <p v-if="answer.replies[q.id]?.comments" class="value comment">“{{ answer.replies[q.id]?.comments }}”</p>
      </template>
      <p v-if="answer.comments" class="value comment">“{{ answer.comments }}”</p>
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
.question {
  display: grid;
  gap: 0.25rem;
  padding-top: 0.35rem;
  border-top: 1px solid var(--border);
}
.qq {
  font-weight: 600;
  font-size: var(--chat-fs);
}
.num {
  color: var(--text-muted);
}
.why {
  font-size: var(--chat-fs-sm);
  color: var(--text-muted);
  white-space: pre-wrap;
}
.rec {
  color: var(--text-muted);
  font-size: var(--chat-fs-sm);
}
.option.neither {
  color: var(--text-muted);
}
.add-comment {
  justify-self: start;
  padding: 0.1rem 0;
  border: 0;
  background: none;
  color: var(--accent-blue);
  font: inherit;
  font-size: var(--chat-fs-sm);
  cursor: pointer;
}
.comment {
  color: var(--text-muted);
  font-size: var(--chat-fs-sm);
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
}
.option {
  display: flex;
  align-items: flex-start; /* the box sits on the option's first line, not halfway down a long one */
  gap: 0.45rem;
  min-height: 2rem; /* tappable */
  padding: 0.35rem 0;
  cursor: pointer;
}
/* A faint line between options: where one long option ends and the next begins. */
.option + .option {
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}
.option input[type='radio'],
.option input[type='checkbox'] {
  flex: none;
  margin: 0.2em 0 0; /* level with the first line of text */
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

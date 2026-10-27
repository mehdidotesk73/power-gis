<script setup lang="ts">
// The assistant: a chat with the dataset processor agent. The user's own
// Anthropic API key is kept on this device (localStorage) and calls go
// straight to Anthropic. The agent works on the workspace through its tools
// (lib/agent/tools.ts): edits land in the draft (Save / Discard as usual);
// it may change only local datasets. When it asks for approval (ask_user), a
// card with Approve / Reject and a notes box waits for the user's answer.
// Screenshots can be pasted into the message box or attached (📎); they're
// shrunk before sending (images.ts).
import UiButton from '../ui/UiButton.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { claudeProvider, CLAUDE_MODEL, CLAUDE_MODELS, describeError } from '../../client/agent/claude'
import { runAgent, type ToolOutcome } from '../../lib/agent/loop'
import { DATASET_PROCESSOR_PROMPT } from '../../lib/agent/prompt'
import { runTool, TOOLS, type AgentHost, type UserAnswer } from '../../lib/agent/tools'
import { MAX_IMAGES, pastedImages, prepareImage, type Attached } from './images'
import { addUsage, emptyUsage, type ChatSession, type ToolCall } from '../../lib/agent/provider'

/** The page's side of the tools; the panel adds asking the user. */
const props = defineProps<{ host: Omit<AgentHost, 'ask'> }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// ── the API key (this device only) ─────────────────────────────────────────

const KEY = 'powergis.anthropicKey'
const readKey = () => {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}
const apiKey = ref(readKey())
const keyDraft = ref('')
const settings = ref(!apiKey.value)
function saveKey() {
  const k = keyDraft.value.trim()
  if (!k) return
  try {
    localStorage.setItem(KEY, k)
  } catch {
    /* private mode: kept for this visit only */
  }
  apiKey.value = k
  keyDraft.value = ''
  settings.value = false
  session = null
}
function forgetKey() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing stored */
  }
  apiKey.value = ''
  session = null
}
const maskedKey = computed(() => (apiKey.value ? `${apiKey.value.slice(0, 10)}…${apiKey.value.slice(-4)}` : ''))

// ── the model (this device; fixed for each chat) ───────────────────────────

const MODEL = 'powergis.agentModel'
const storedModel = (() => {
  try {
    return localStorage.getItem(MODEL)
  } catch {
    return null
  }
})()
/** The model new chats use. */
const model = ref(CLAUDE_MODELS.some((m) => m.id === storedModel) ? storedModel! : CLAUDE_MODEL)
watch(model, (m) => {
  try {
    localStorage.setItem(MODEL, m)
  } catch {
    /* per-device convenience */
  }
})
/** The model the current chat runs on (set when it starts). */
const chatModel = ref<string | null>(null)
const labelOf = (id: string) => CLAUDE_MODELS.find((m) => m.id === id)?.label ?? id

// ── the conversation ───────────────────────────────────────────────────────

type Item =
  | { kind: 'user'; text: string; images?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; call: ToolCall; state: 'running' | 'ok' | 'error'; summary: string; result?: string; open: boolean }
  | { kind: 'note'; text: string; tone: 'info' | 'warn' | 'error' }
  | { kind: 'ask'; question: string; details?: string; notes: string; answer?: UserAnswer }

const items = ref<Item[]>([])
const draft = ref('')
const busy = ref(false)
const usage = ref(emptyUsage())
let session: ChatSession | null = null
/** Bumped by New chat, so a run stopped for it doesn't write into the fresh conversation. */
let chatGen = 0
let controller: AbortController | null = null
const scroller = ref<HTMLElement>()

// ── asking the user (the ask_user tool) ────────────────────────────────────

/** Resolves the question the agent is waiting on. */
let answerPending: ((a: UserAnswer) => void) | null = null
const waiting = ref(false)
function ask(question: string, details?: string): Promise<UserAnswer> {
  return new Promise((resolve) => {
    items.value.push({ kind: 'ask', question, ...(details ? { details } : {}), notes: '' })
    const it = items.value[items.value.length - 1] as Extract<Item, { kind: 'ask' }>
    waiting.value = true
    answerPending = (a) => {
      it.answer = a
      answerPending = null
      waiting.value = false
      resolve(a)
    }
  })
}
function answer(it: Extract<Item, { kind: 'ask' }>, a: UserAnswer['answer']) {
  const notes = it.notes.trim()
  answerPending?.({ answer: a, ...(notes ? { notes } : {}) })
}
const host: AgentHost = { ...props.host, ask }

const TOOL_LABEL: Record<string, string> = {
  list_datasets: 'List datasets',
  get_workspace: 'Read the workspace',
  query_sql: 'Query',
  update_workspace: 'Update the workspace',
  visualization_stats: 'Check the values drawn',
  run_transform: 'Run a transform',
  update_dataset: 'Rename / describe a dataset',
  delete_dataset: 'Delete a dataset',
}

async function scrollDown() {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(() => items.value.length, scrollDown)

// ── attached images ────────────────────────────────────────────────────────

const attached = ref<Attached[]>([])
const attachError = ref('')
const picker = ref<HTMLInputElement>()
async function attach(files: Blob[]) {
  attachError.value = ''
  for (const f of files) {
    if (attached.value.length >= MAX_IMAGES) {
      attachError.value = `Up to ${MAX_IMAGES} images per message.`
      break
    }
    const im = await prepareImage(f)
    if (typeof im === 'string') attachError.value = im
    else attached.value = [...attached.value, im]
  }
}
function onPaste(e: ClipboardEvent) {
  const files = pastedImages(e)
  if (!files.length) return // ordinary text paste
  e.preventDefault()
  void attach(files)
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  void attach(files)
}
const unattach = (i: number) => (attached.value = attached.value.filter((_, j) => j !== i))
const canSend = computed(() => !!apiKey.value && (!!draft.value.trim() || attached.value.length > 0))

async function send() {
  const text = draft.value.trim()
  const images = attached.value
  if ((!text && !images.length) || busy.value || !apiKey.value) return
  draft.value = ''
  attached.value = []
  attachError.value = ''
  items.value.push({ kind: 'user', text, ...(images.length ? { images: images.map((im) => im.url) } : {}) })
  if (!session) {
    session = claudeProvider.start({ apiKey: apiKey.value, model: model.value, system: DATASET_PROCESSOR_PROMPT, tools: TOOLS })
    chatModel.value = model.value
  }
  busy.value = true
  const ctl = (controller = new AbortController())
  const gen = chatGen
  const live = () => gen === chatGen
  let current: Extract<Item, { kind: 'assistant' }> | null = null
  try {
    const { end } = await runAgent(
      session,
      (name, input) => runTool(host, name, input),
      { text, ...(images.length ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) } : {}) },
      {
        onTurnStart: () => {
          current = null
        },
        onText: (delta) => {
          if (!live()) return
          if (!current) {
            items.value.push({ kind: 'assistant', text: '' })
            current = items.value[items.value.length - 1] as Extract<Item, { kind: 'assistant' }>
          }
          current.text += delta
          void scrollDown()
        },
        onUsage: (turn) => (usage.value = addUsage(usage.value, turn)),
        onToolStart: (call) => {
          current = null
          if (!live() || call.name === 'ask_user') return // ask_user: its card is the step
          items.value.push({ kind: 'tool', call, state: 'running', summary: '', open: false })
        },
        onToolEnd: (call, out: ToolOutcome) => {
          const it = items.value.find((x) => x.kind === 'tool' && x.call.id === call.id) as Extract<Item, { kind: 'tool' }> | undefined
          if (it) Object.assign(it, { state: out.isError ? 'error' : 'ok', summary: out.summary, result: out.content })
        },
      },
      ctl.signal,
    )
    if (!live()) return
    if (end === 'refused') items.value.push({ kind: 'note', tone: 'warn', text: 'Claude declined this request. Try rephrasing it.' })
    else if (end === 'truncated') items.value.push({ kind: 'note', tone: 'warn', text: 'The answer was cut off (too long). Ask it to continue, or to do less at once.' })
    else if (end === 'step-limit') items.value.push({ kind: 'note', tone: 'warn', text: 'Stopped after many steps. Say "continue" to let it carry on.' })
    else if (end === 'stopped') items.value.push({ kind: 'note', tone: 'info', text: 'Stopped.' })
  } catch (e) {
    if (live()) items.value.push({ kind: 'note', tone: ctl.signal.aborted ? 'info' : 'error', text: describeError(e) })
  } finally {
    // A step cut short by Stop never reports back: show it as stopped, not running forever.
    if (live()) for (const it of items.value) if (it.kind === 'tool' && it.state === 'running') Object.assign(it, { state: 'error', summary: 'stopped' })
    busy.value = false
    if (controller === ctl) controller = null
  }
}
/** Stops the run at once, whatever it's waiting on (runAgent races every step against the signal). */
function stop() {
  answerPending?.({ answer: 'reject', notes: 'Stopped by the user.' })
  controller?.abort()
}
/**
 * Clears the conversation (it can't be reopened), after asking when `confirmFirst`. Works while
 * the assistant is busy too: it stops the run first, and the stopped run's last words are dropped.
 */
function newChat(confirmFirst = false) {
  if (confirmFirst && items.value.length && !confirm(busy.value ? 'Stop the assistant and start a new chat? This conversation will be cleared (your workspace stays as it is).' : 'Start a new chat? This conversation will be cleared (your workspace stays as it is).')) return
  if (busy.value) stop()
  chatGen++
  items.value = []
  usage.value = emptyUsage()
  session = null
  chatModel.value = null
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
    e.preventDefault()
    void send()
  }
}

/** Escaped text with **bold** and `code` (the model's light markdown); nothing else becomes HTML. */
function format(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>')
}
const toolInput = (call: ToolCall) => JSON.stringify(call.input, null, 2)
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
const usageText = computed(() => {
  const u = usage.value
  const inTotal = u.input + u.cacheRead + u.cacheWrite
  return inTotal || u.output ? `${k(inTotal)} in${u.cacheRead ? ` (${k(u.cacheRead)} cached)` : ''} · ${k(u.output)} out` : ''
})
</script>

<template>
  <aside class="assistant" aria-label="Assistant">
    <header>
      <div class="title">
        <span class="eyebrow">Assistant</span>
        <strong>Dataset processor</strong>
        <span class="muted small">{{ labelOf(chatModel ?? model) }}</span>
      </div>
      <UiButton size="compact" title="Clear this conversation and start over" :disabled="!items.length" @click="newChat(true)">New chat</UiButton>
      <UiButton size="compact" icon="⚙" :active="settings" :aria-pressed="settings" title="API key and model" aria-label="Settings: API key and model" @click="settings = !settings" />
      <UiButton size="compact" icon="✕" title="Close" aria-label="Close" @click="emit('close')" />
    </header>

    <section v-if="settings" class="settings">
      <p v-if="apiKey" class="muted">Using key <code>{{ maskedKey }}</code> on this device.</p>
      <label for="agent-key">Anthropic API key</label>
      <input id="agent-key" v-model="keyDraft" type="password" autocomplete="off" placeholder="sk-ant-…" @keydown.enter="saveKey" />
      <div class="row">
        <UiButton v-if="apiKey" size="compact" @click="forgetKey">Remove key</UiButton>
        <UiButton size="compact" tone="primary" :disabled="!keyDraft.trim()" @click="saveKey">Save key</UiButton>
      </div>
      <p class="muted small">
        The key stays on this device and is sent only to Anthropic; usage is billed to your Anthropic account (create a key at console.anthropic.com, and set a spending limit there).
      </p>
      <label for="agent-model">Model</label>
      <select id="agent-model" v-model="model">
        <option v-for="m in CLAUDE_MODELS" :key="m.id" :value="m.id">{{ m.label }} · {{ m.note }}</option>
      </select>
      <p class="muted small">Prices are dollars per million tokens, in / out. A chat keeps the model it started with.</p>
      <div v-if="chatModel && chatModel !== model" class="switch">
        <span>This chat uses {{ labelOf(chatModel) }}; {{ labelOf(model) }} applies to the next one.</span>
        <UiButton size="compact" :disabled="busy" @click="newChat()">Start a new chat</UiButton>
      </div>
    </section>

    <div ref="scroller" class="chat">
      <div v-if="!items.length" class="empty">
        <p>Ask for data to be prepared or shown, for example:</p>
        <p class="ex">“Show the latest average home price per county, and per state.”</p>
        <p class="muted small">It reads your datasets, writes transforms and sets up visualizations in your workspace. Its edits are unsaved until you Save. It can change or delete only <b>local</b> datasets.</p>
      </div>
      <template v-for="(it, i) in items" :key="i">
        <div v-if="it.kind === 'user'" class="msg user">
          <div v-if="it.images" class="thumbs">
            <img v-for="(src, j) in it.images" :key="j" :src="src" alt="Attached image" />
          </div>
          <span v-if="it.text">{{ it.text }}</span>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- format() escapes everything first -->
        <p v-else-if="it.kind === 'assistant'" class="msg bot" v-html="format(it.text)" />
        <div v-else-if="it.kind === 'tool'" class="tool" :class="it.state">
          <button class="tool-line" :aria-expanded="it.open" @click="it.open = !it.open">
            <span class="dot" aria-hidden="true">{{ it.state === 'running' ? '…' : it.state === 'ok' ? '✓' : '⚠' }}</span>
            <span class="name">{{ TOOL_LABEL[it.call.name] ?? it.call.name }}</span>
            <span class="sum">{{ it.summary }}</span>
          </button>
          <div v-if="it.open" class="detail">
            <pre>{{ toolInput(it.call) }}</pre>
            <pre v-if="it.result">{{ it.result.length > 4000 ? `${it.result.slice(0, 4000)}…` : it.result }}</pre>
          </div>
        </div>
        <div v-else-if="it.kind === 'ask'" class="ask" :class="{ done: it.answer }">
          <p class="q">{{ it.question }}</p>
          <p v-if="it.details" class="details">{{ it.details }}</p>
          <template v-if="!it.answer">
            <textarea v-model="it.notes" rows="2" placeholder="Notes (optional)" aria-label="Notes for the assistant" />
            <div class="row">
              <UiButton size="compact" @click="answer(it, 'reject')">Reject</UiButton>
              <UiButton size="compact" tone="ok" @click="answer(it, 'approve')">Approve</UiButton>
            </div>
          </template>
          <p v-else class="answered" :class="it.answer.answer">
            {{ it.answer.answer === 'approve' ? '✓ Approved' : '✕ Rejected' }}<span v-if="it.answer.notes"> — {{ it.answer.notes }}</span>
          </p>
        </div>
        <p v-else class="note" :class="it.tone">{{ it.text }}</p>
      </template>
      <p v-if="busy" class="muted working">{{ waiting ? 'Waiting for your answer…' : 'Working…' }}</p>
    </div>

    <footer>
      <div v-if="attached.length" class="thumbs pending">
        <span v-for="(im, i) in attached" :key="i" class="thumb">
          <img :src="im.url" alt="Image to send" />
          <button class="x" aria-label="Remove image" @click="unattach(i)">✕</button>
        </span>
      </div>
      <p v-if="attachError" class="note warn">{{ attachError }}</p>
      <textarea
        id="agent-input"
        v-model="draft"
        rows="2"
        :disabled="!apiKey || waiting"
        :placeholder="!apiKey ? 'Add your API key (⚙) to start' : waiting ? 'Answer the question above' : 'Ask the assistant…'"
        aria-label="Message"
        @keydown="onKey"
        @paste="onPaste"
      />
      <div class="row">
        <UiButton size="compact" icon="📎" title="Attach a screenshot or photo" aria-label="Attach an image" :disabled="!apiKey || waiting" @click="picker?.click()" />
        <input ref="picker" class="hidden" type="file" accept="image/*" multiple @change="onPick" />
        <span class="muted small usage">{{ usageText }}</span>
        <UiButton v-if="busy" size="compact" @click="stop">Stop</UiButton>
        <UiButton v-else size="compact" tone="primary" :disabled="!canSend || waiting" @click="send">Send</UiButton>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
.assistant {
  overflow: hidden;
  /* Desktop: fills its docked column on the right of the page (MapPage sizes it). */
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.86rem;
}
/* Phones: a sheet over the lower part of the screen, so the map stays in view above. */
@media (max-width: 48rem) {
  .assistant {
    position: fixed;
    z-index: 70;
    left: 0;
    right: 0;
    bottom: 0;
    height: 72svh;
    border-radius: var(--radius) var(--radius) 0 0;
    box-shadow: var(--shadow);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
}
header {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.55rem 0.6rem;
  border-bottom: 1px solid var(--border);
}
.title {
  display: grid;
  flex: 1;
  min-width: 0;
}
.eyebrow {
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-blue);
}
.settings {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.35rem;
  padding: 0.6rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev-2);
}
.settings input,
.settings select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  font-size: 16px; /* below 16px iOS zooms on focus */
  padding: 0.35rem 0.45rem;
}
.switch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: var(--warn);
}
.chat {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: grid;
  align-content: start;
  gap: 0.45rem;
  padding: 0.6rem;
}
.empty {
  display: grid;
  gap: 0.35rem;
  color: var(--text-muted);
}
.empty p {
  margin: 0;
}
.ex {
  color: var(--text);
  font-style: italic;
}
.msg {
  margin: 0;
  max-width: 92%;
  padding: 0.45rem 0.6rem;
  border-radius: 0.6rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.45;
}
.msg.user {
  justify-self: end;
  background: color-mix(in srgb, var(--accent-blue) 22%, var(--bg-elev-2));
}
.msg.bot {
  justify-self: start;
  background: var(--bg-elev-2);
}
.msg :deep(code),
.settings code,
.muted code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
}
.tool {
  justify-self: start;
  max-width: 100%;
  min-width: 0;
  border-left: 2px solid var(--border-strong);
  padding-left: 0.4rem;
}
.tool.ok {
  border-color: var(--ok);
}
.tool.error {
  border-color: var(--warn);
}
.tool-line {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  max-width: 100%;
  padding: 0.1rem 0;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 0.78rem;
  text-align: left;
}
.tool-line .name {
  color: var(--text);
  white-space: nowrap;
}
.tool-line .sum {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.tool.error .dot {
  color: var(--warn);
}
.tool.ok .dot {
  color: var(--ok);
}
.detail {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
}
.detail pre {
  margin: 0;
  max-height: 12rem;
  overflow: auto;
  padding: 0.35rem;
  border-radius: 0.3rem;
  background: var(--bg);
  font-size: 0.7rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.note {
  margin: 0;
  font-size: 0.78rem;
}
.note.info {
  color: var(--text-muted);
}
.note.warn {
  color: var(--warn);
}
.note.error {
  color: var(--danger);
}
.ask {
  display: grid;
  gap: 0.4rem;
  padding: 0.55rem 0.6rem;
  border: 1px solid var(--accent-blue);
  border-radius: 0.6rem;
  background: color-mix(in srgb, var(--accent-blue) 8%, var(--bg-elev-2));
}
.ask.done {
  border-color: var(--border);
  background: var(--bg-elev-2);
}
.ask p {
  margin: 0;
}
.ask .q {
  font-weight: 600;
}
.ask .details {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text-muted);
  font-size: 0.8rem;
}
.ask textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 0.35rem 0.45rem;
  font: inherit;
  font-size: 16px; /* below 16px iOS zooms on focus */
}
.answered {
  font-size: 0.8rem;
}
.answered.approve {
  color: var(--ok);
}
.answered.reject {
  color: var(--warn);
}
.thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.thumbs img {
  max-width: 7rem;
  max-height: 5rem;
  border-radius: 0.35rem;
  border: 1px solid var(--border);
  object-fit: cover;
}
.msg.user .thumbs + span {
  display: block;
  margin-top: 0.3rem;
}
.thumb {
  position: relative;
}
.thumb .x {
  position: absolute;
  top: -0.4rem;
  right: -0.4rem;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.65rem;
}
.hidden {
  display: none;
}
.working {
  margin: 0;
}
footer {
  display: grid;
  gap: 0.35rem;
  padding: 0.5rem 0.6rem;
  border-top: 1px solid var(--border);
}
footer textarea {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  padding: 0.4rem 0.5rem;
  font: inherit; /* the panel's text size; iOS's zoom-on-focus is turned off in main.ts */
  line-height: 1.4;
}
.row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.4rem;
}
.usage {
  margin-right: auto;
}
.muted {
  color: var(--text-muted);
}
.small {
  font-size: 0.74rem;
  margin: 0;
}
</style>

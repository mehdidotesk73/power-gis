<script setup lang="ts">
// The assistant: a chat with the dataset processor agent. The user's own
// Anthropic API key is kept on this device (localStorage) and calls go
// straight to Anthropic. The agent works on the workspace through its tools
// (lib/agent/tools.ts): edits land in the draft (Save / Discard as usual);
// it may change only local datasets. When it asks for approval (ask_user), a
// card with Approve / Reject and a notes box waits for the user's answer.
import { computed, nextTick, ref, watch } from 'vue'
import { claudeProvider, CLAUDE_MODEL, describeError } from '../../client/agent/claude'
import { runAgent, type ToolOutcome } from '../../lib/agent/loop'
import { DATASET_PROCESSOR_PROMPT } from '../../lib/agent/prompt'
import { runTool, TOOLS, type AgentHost, type UserAnswer } from '../../lib/agent/tools'
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

// ── the conversation ───────────────────────────────────────────────────────

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; call: ToolCall; state: 'running' | 'ok' | 'error'; summary: string; result?: string; open: boolean }
  | { kind: 'note'; text: string; tone: 'info' | 'warn' | 'error' }
  | { kind: 'ask'; question: string; details?: string; notes: string; answer?: UserAnswer }

const items = ref<Item[]>([])
const draft = ref('')
const busy = ref(false)
const usage = ref(emptyUsage())
let session: ChatSession | null = null
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
  run_transform: 'Run a transform',
  delete_dataset: 'Delete a dataset',
}

async function scrollDown() {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(() => items.value.length, scrollDown)

async function send() {
  const text = draft.value.trim()
  if (!text || busy.value || !apiKey.value) return
  draft.value = ''
  items.value.push({ kind: 'user', text })
  session ??= claudeProvider.start({ apiKey: apiKey.value, system: DATASET_PROCESSOR_PROMPT, tools: TOOLS })
  busy.value = true
  controller = new AbortController()
  let current: Extract<Item, { kind: 'assistant' }> | null = null
  try {
    const { end, usage: used } = await runAgent(
      session,
      (name, input) => runTool(host, name, input),
      text,
      {
        onTurnStart: () => {
          current = null
        },
        onText: (delta) => {
          if (!current) {
            items.value.push({ kind: 'assistant', text: '' })
            current = items.value[items.value.length - 1] as Extract<Item, { kind: 'assistant' }>
          }
          current.text += delta
          void scrollDown()
        },
        onToolStart: (call) => {
          current = null
          if (call.name === 'ask_user') return // its card is the step
          items.value.push({ kind: 'tool', call, state: 'running', summary: '', open: false })
        },
        onToolEnd: (call, out: ToolOutcome) => {
          const it = items.value.find((x) => x.kind === 'tool' && x.call.id === call.id) as Extract<Item, { kind: 'tool' }> | undefined
          if (it) Object.assign(it, { state: out.isError ? 'error' : 'ok', summary: out.summary, result: out.content })
        },
      },
      controller.signal,
    )
    usage.value = addUsage(usage.value, used)
    if (end === 'refused') items.value.push({ kind: 'note', tone: 'warn', text: 'Claude declined this request. Try rephrasing it.' })
    else if (end === 'truncated') items.value.push({ kind: 'note', tone: 'warn', text: 'The answer was cut off (too long). Ask it to continue, or to do less at once.' })
    else if (end === 'step-limit') items.value.push({ kind: 'note', tone: 'warn', text: 'Stopped after many steps. Say "continue" to let it carry on.' })
    else if (end === 'stopped') items.value.push({ kind: 'note', tone: 'info', text: 'Stopped.' })
  } catch (e) {
    items.value.push({ kind: 'note', tone: controller?.signal.aborted ? 'info' : 'error', text: describeError(e) })
  } finally {
    busy.value = false
    controller = null
  }
}
function stop() {
  controller?.abort()
  answerPending?.({ answer: 'reject', notes: 'Stopped by the user.' })
}
function newChat() {
  if (busy.value) return
  items.value = []
  usage.value = emptyUsage()
  session = null
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
      </div>
      <button class="icon" :aria-pressed="settings" title="API key" aria-label="API key settings" @click="settings = !settings">⚙</button>
      <button class="icon" title="New chat" aria-label="New chat" :disabled="busy || !items.length" @click="newChat">＋</button>
      <button class="icon" title="Close" aria-label="Close" @click="emit('close')">✕</button>
    </header>

    <section v-if="settings" class="settings">
      <p v-if="apiKey" class="muted">Using key <code>{{ maskedKey }}</code> on this device.</p>
      <label for="agent-key">Anthropic API key</label>
      <input id="agent-key" v-model="keyDraft" type="password" autocomplete="off" placeholder="sk-ant-…" @keydown.enter="saveKey" />
      <div class="row">
        <button v-if="apiKey" class="btn" @click="forgetKey">Remove key</button>
        <button class="btn primary" :disabled="!keyDraft.trim()" @click="saveKey">Save key</button>
      </div>
      <p class="muted small">
        The key stays on this device and is sent only to Anthropic; usage is billed to your Anthropic account (create a key at console.anthropic.com, and set a spending limit there). Model: <code>{{ CLAUDE_MODEL }}</code>.
      </p>
    </section>

    <div ref="scroller" class="chat">
      <div v-if="!items.length" class="empty">
        <p>Ask for data to be prepared or shown, for example:</p>
        <p class="ex">“Show the latest average home price per county, and per state.”</p>
        <p class="muted small">It reads your datasets, writes transforms and sets up visualizations in your workspace. Its edits are unsaved until you Save. It can change or delete only <b>local</b> datasets.</p>
      </div>
      <template v-for="(it, i) in items" :key="i">
        <p v-if="it.kind === 'user'" class="msg user">{{ it.text }}</p>
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
              <button class="btn" @click="answer(it, 'reject')">Reject</button>
              <button class="btn approve" @click="answer(it, 'approve')">Approve</button>
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
      <textarea
        id="agent-input"
        v-model="draft"
        rows="2"
        :disabled="!apiKey || waiting"
        :placeholder="!apiKey ? 'Add your API key (⚙) to start' : waiting ? 'Answer the question above' : 'Ask the assistant…'"
        aria-label="Message"
        @keydown="onKey"
      />
      <div class="row">
        <span class="muted small usage">{{ usageText }}</span>
        <button v-if="busy" class="btn" @click="stop">Stop</button>
        <button v-else class="btn primary" :disabled="!draft.trim() || !apiKey" @click="send">Send</button>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
.assistant {
  position: fixed;
  z-index: 70;
  top: calc(env(safe-area-inset-top, 0px) + 3.2rem);
  right: max(0.5rem, env(safe-area-inset-right, 0px));
  bottom: calc(0.5rem + env(safe-area-inset-bottom, 0px));
  width: min(26rem, calc(100vw - 1rem));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-elev);
  color: var(--text);
  box-shadow: var(--shadow);
  font-size: 0.86rem;
}
/* Phones: a sheet over the lower part of the screen, so the map stays in view above. */
@media (max-width: 40rem) {
  .assistant {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    height: 72svh;
    border-radius: var(--radius) var(--radius) 0 0;
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
.icon {
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-elev-2);
  color: var(--text-muted);
}
.icon[aria-pressed='true'] {
  border-color: var(--accent-blue);
  color: var(--text);
}
.icon:disabled {
  opacity: 0.4;
}
.settings {
  display: grid;
  gap: 0.35rem;
  padding: 0.6rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev-2);
}
.settings input {
  font-size: 16px; /* below 16px iOS zooms on focus */
  padding: 0.35rem 0.45rem;
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
.btn.approve {
  background: var(--ok);
  border-color: var(--ok);
  color: var(--on-accent);
  font-weight: 600;
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
  font: inherit;
  font-size: 16px; /* below 16px iOS zooms on focus */
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
.btn {
  min-height: 2.1rem;
  padding: 0.2rem 0.8rem;
  border: 1px solid var(--border-strong);
  border-radius: 0.4rem;
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 0.82rem;
}
.btn.primary {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: var(--on-accent);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.5;
}
.muted {
  color: var(--text-muted);
}
.small {
  font-size: 0.74rem;
  margin: 0;
}
</style>

<script setup lang="ts">
// The assistant: a chat with the dataset processor agent. The user's own
// Anthropic API key is kept on this device (localStorage) and calls go
// straight to Anthropic. The agent works on the workspace through its tools
// (lib/agent/tools.ts): edits land in the draft (Save / Discard as usual);
// it may change only local datasets. When it asks something (ask_user), a card
// with the fields and buttons it composed waits for the user's answer
// (AskCard). It can send the scout or the scraper (Managed Agents, through our
// relay, signed in): each run shows as a step that expands into its log and
// results, and one still running when the page reloads is picked up again.
// Screenshots can be pasted into the message box or attached (📎); they're
// shrunk before sending (images.ts).
import UiButton from '../ui/UiButton.vue'
import LabPanel from './LabPanel.vue'
import AskCard from './AskCard.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { chatCost, claudeProvider, CLAUDE_MODELS, describeError } from '../../client/agent/claude'
import { DEFAULT_PROFILE, PROFILES, profileById, profileStats, recordChat, statsLine, type AgentProfile, type ChatRecord } from '../../lib/agent/profiles'
import { runAgent, type ToolOutcome } from '../../lib/agent/loop'
import { DATASET_PROCESSOR_PROMPT } from '../../lib/agent/prompt'
import { forgetChat, IMPORTABLE, runTool, TOOLS, type AgentHost, type WebRole, type WebRun } from '../../lib/agent/tools'
import { STOPPED, type Form, type FormAnswer } from '../../lib/agent/form'
import { activeRun, downloadFile, followRun, forgetRun, SignInNeeded, startRun, traceUrl, type ActiveRun, type RunEvent, type RunResult } from '../../client/agent/managed'
import { saveFile } from '../../client/saveFile'
import { auth } from '../../client/auth'
import { EDITOR_TOOL } from '../../lib/agent/workspaceFiles'
import { MAX_IMAGES, pastedImages, prepareImage, type Attached } from './images'
import { addUsage, emptyUsage, type ChatSession, type ToolCall } from '../../lib/agent/provider'

/** The page's side of the tools; the panel adds asking the user and the web runs. */
const props = defineProps<{ host: Omit<AgentHost, 'ask' | 'web' | 'importWebFile'> }>()
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

// ── the profile (this device; fixed for each chat) ─────────────────────────

const PROFILE = 'powergis.agentProfile'
const CHATS = 'powergis.profileChats'
const stored = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* per-device convenience */
  }
}
/** The profile new chats use. */
const profileId = ref(profileById(stored(PROFILE) ?? DEFAULT_PROFILE).id)
watch(profileId, (p) => store(PROFILE, p))
/** The profile the current chat runs on (set when it starts). */
const chatProfile = ref<AgentProfile | null>(null)
/** The current chat's line in the log (one per New chat). */
let chatRecord: ChatRecord | null = null
const labelOf = (id: string) => CLAUDE_MODELS.find((m) => m.id === id)?.label.replace(/^Claude /, '') ?? id
/** "chat Haiku 5.5 · scout Sonnet 5.5 · …": the models a profile uses. */
const modelsLine = (p: AgentProfile) => `chat ${labelOf(p.models.assistant)} · scout ${labelOf(p.models.scout)} · scraper ${labelOf(p.models.scraper)} · reviewer ${labelOf(p.models.reviewer)}`
const chatLog = ref<ChatRecord[]>(
  (() => {
    try {
      const v = JSON.parse(stored(CHATS) ?? '[]')
      return Array.isArray(v) ? (v as ChatRecord[]) : []
    } catch {
      return []
    }
  })(),
)
const stats = computed(() => profileStats(chatLog.value))
/** The profile the next chat starts with. */
const nextProfile = computed(() => profileById(profileId.value))

// ── the conversation ───────────────────────────────────────────────────────

type Item =
  | { kind: 'user'; text: string; images?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; call: ToolCall; state: 'running' | 'ok' | 'error'; summary: string; result?: string; open: boolean }
  | { kind: 'note'; text: string; tone: 'info' | 'warn' | 'error'; detail?: string }
  | { kind: 'ask'; form: Form; answer?: FormAnswer }
  | RunItem

/** A scout or scraper run: a step like the others, expanding into its brief, log and results. */
interface RunItem {
  kind: 'run'
  role: WebRole
  brief: string
  state: 'running' | 'ok' | 'error'
  startedAt: number
  sessionId?: string
  log: RunEvent[]
  result?: RunResult
  /** The scraper's CSVs: the dataset each became, or why not. */
  imported: { name: string; id?: string; error?: string }[]
  error?: string
  open: boolean
  /** Picked up after a reload (no chat waits on it). */
  resumed?: boolean
  stop: { stopped: boolean }
}
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
let answerPending: ((a: FormAnswer) => void) | null = null
const waiting = ref(false)
function ask(form: Form): Promise<FormAnswer> {
  return new Promise((resolve) => {
    items.value.push({ kind: 'ask', form })
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

// ── the scout and the scraper (Managed Agents, through the relay) ──────────

/** Ticks while a run is going, for its elapsed time. */
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
const running = computed(() => items.value.some((x) => x.kind === 'run' && x.state === 'running'))
watch(running, (r) => {
  clearInterval(ticker)
  if (r) ticker = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => clearInterval(ticker))

function pushRun(run: { role: WebRole; brief: string; startedAt: number; sessionId?: string }, resumed = false): RunItem {
  items.value.push({ kind: 'run', ...run, state: 'running', log: [], imported: [], open: false, ...(resumed ? { resumed } : {}), stop: { stopped: false } })
  return items.value[items.value.length - 1] as RunItem
}
/** Stops a run from its card (the chat's Stop stops it too, while the chat waits on it). */
function stopRun(it: RunItem) {
  it.stop.stopped = true
}
const describeRunError = (e: unknown) => (e instanceof SignInNeeded ? e.message : describeError(e))

/** Follows a started run in its card to the end. */
async function follow(it: RunItem, run: ActiveRun, chat?: AbortSignal): Promise<RunResult> {
  const signal = {
    get stopped() {
      return it.stop.stopped || !!chat?.aborted
    },
  }
  const result = await followRun(apiKey.value, run, { onEvent: (e) => it.log.push(e), signal })
  it.result = result
  it.state = result.stop === 'end_turn' ? 'ok' : 'error'
  return result
}

/** The tools' web(): sends the scout or the scraper and waits for it, the card showing its progress. */
async function web(role: WebRole, brief: string, capDollars: number): Promise<WebRun | string> {
  if (!auth.user) return new SignInNeeded().message
  if (running.value) return 'Another scout or scraper run is still going; wait for it (or stop it) first.'
  const it = pushRun({ role, brief, startedAt: Date.now() })
  try {
    const run = await startRun(apiKey.value, { role, model: (chatProfile.value ?? nextProfile.value).models[role], brief, capDollars })
    it.sessionId = run.sessionId
    const r = await follow(it, run, controller?.signal)
    return { sessionId: r.sessionId, report: r.report, files: r.files, ...(r.missing ? { missing: r.missing } : {}), ...(r.cost !== undefined ? { cost: r.cost } : {}), elapsedSeconds: r.elapsedSeconds, stop: r.stop }
  } catch (e) {
    it.state = 'error'
    it.error = describeRunError(e)
    return it.error
  } finally {
    forgetRun()
  }
}

/** The tools' importWebFile(): one of a run's CSVs, as a new dataset. */
async function importWebFile(fileId: string, name: string, description: string): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const it = [...items.value].reverse().find((x): x is RunItem => x.kind === 'run' && !!x.result?.files.some((f) => f.id === fileId))
  let r: { ok: true; id: string } | { ok: false; message: string }
  if (!props.host.importCsv) r = { ok: false, message: 'Importing files isn’t available here.' }
  else {
    try {
      const blob = await downloadFile(apiKey.value, fileId)
      r = await props.host.importCsv(new File([blob], name, { type: /\.(geo)?json$/i.test(name) ? 'application/geo+json' : 'text/csv' }), description)
    } catch (e) {
      r = { ok: false, message: describeRunError(e) }
    }
  }
  it?.imported.push(r.ok ? { name, id: r.id } : { name, error: r.message })
  return r
}

/** A run still going when the page last closed: follow it again, and take in the scraper's CSVs. */
onMounted(async () => {
  const run = activeRun()
  if (!run || !apiKey.value) return
  const it = pushRun(run, true)
  try {
    const r = await follow(it, run)
    if (run.role === 'scraper') {
      const day = new Date(run.startedAt).toISOString().slice(0, 10)
      for (const f of r.files) if (IMPORTABLE.test(f.name)) await importWebFile(f.id, f.name, `From the web, ${day} (scraper run ${r.sessionId}).`)
    }
  } catch (e) {
    it.state = 'error'
    it.error = describeRunError(e)
  } finally {
    forgetRun()
  }
})

async function saveRunFile(f: { id: string; name: string }) {
  try {
    await saveFile(await downloadFile(apiKey.value, f.id), f.name)
  } catch (e) {
    items.value.push({ kind: 'note', tone: 'error', text: `Couldn't download ${f.name}: ${describeRunError(e)}` })
  }
}

const ROLE_LABEL: Record<WebRole, string> = { scout: 'Scout', scraper: 'Scraper' }
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
/** The run's one line: while running, its time and latest step; then how it ended. */
function runSummary(it: RunItem): string {
  if (it.state === 'running') {
    const last = [...it.log].reverse().find((e) => e.kind === 'tool' || e.kind === 'message')
    return `running · ${clock((now.value - it.startedAt) / 1000)} · ${last ? last.text.split('\n')[0] : 'starting'}`
  }
  if (it.error) return it.error
  const r = it.result
  if (!r) return ''
  const datasets = it.imported.filter((x) => x.id).length
  return [
    r.stop === 'end_turn' ? 'finished' : r.stop,
    `${r.elapsedSeconds} s`,
    r.cost !== undefined ? `$${r.cost.toFixed(2)}` : '',
    it.role === 'scraper' ? `${datasets} dataset${datasets === 1 ? '' : 's'}` : '',
    r.missing?.length ? `${r.missing.length} file${r.missing.length === 1 ? '' : 's'} missing` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
const datasetName = (id: string) => props.host.record(id)?.name ?? id

const host: AgentHost = { ...props.host, ask, web, importWebFile }

const TOOL_LABEL: Record<string, string> = {
  list_datasets: 'List datasets',
  get_workspace: 'Read the workspace',
  send_scout: 'Send the scout',
  send_scraper: 'Send the scraper',
  query_sql: 'Query',
  apply_workspace: 'Apply the edits',
  visualization_stats: 'Check the values drawn',
  run_transform: 'Run a transform',
  delete_dataset: 'Delete a dataset',
}

/** A step's title: the tool, or for the file editor what it did to which file ("Edit /transforms/….sql"). */
function toolLabel(call: ToolCall): string {
  if (call.name === EDITOR_TOOL) {
    const i = (call.input ?? {}) as { command?: string; path?: string }
    const verb = { view: 'View', create: 'Write', str_replace: 'Edit', insert: 'Edit' }[i.command ?? ''] ?? 'File'
    return `${verb} ${i.path ?? ''}`.trim()
  }
  return TOOL_LABEL[call.name] ?? call.name
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
    const p = nextProfile.value
    session = claudeProvider.start({ apiKey: apiKey.value, model: p.models.assistant, system: DATASET_PROCESSOR_PROMPT, tools: TOOLS })
    chatProfile.value = p
    chatRecord = { chat: crypto.randomUUID(), profile: p.id, startedAt: Date.now(), turns: 0, tokensIn: 0, tokensOut: 0, runs: 0 }
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
          // ask_user: its card is the step; the scout and scraper: their approval card, then their run.
          if (!live() || call.name === 'ask_user' || call.name === 'send_scout' || call.name === 'send_scraper') return
          items.value.push({ kind: 'tool', call, state: 'running', summary: '', open: false })
        },
        onToolEnd: (call, out: ToolOutcome) => {
          const it = items.value.find((x) => x.kind === 'tool' && x.call.id === call.id) as Extract<Item, { kind: 'tool' }> | undefined
          if (it) Object.assign(it, { state: out.isError ? 'error' : 'ok', summary: out.summary, result: out.content })
          // A question card or a run refused before it showed: show the step, so its reason isn't lost.
          else if (out.isError && live()) items.value.push({ kind: 'tool', call, state: 'error', summary: out.summary, result: out.content, open: false })
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
    if (live()) {
      const text = describeError(e)
      const raw = (e as Error)?.message ?? String(e)
      items.value.push({ kind: 'note', tone: ctl.signal.aborted ? 'info' : 'error', text, ...(raw && raw !== text ? { detail: raw } : {}) })
    }
  } finally {
    // A step cut short by Stop never reports back: show it as stopped, not running forever.
    if (live()) for (const it of items.value) if (it.kind === 'tool' && it.state === 'running') Object.assign(it, { state: 'error', summary: 'stopped' })
    busy.value = false
    if (controller === ctl) controller = null
    if (live()) logChat()
  }
}
/** Updates this chat's line in the per-profile log (after each finished turn). */
function logChat() {
  if (!chatRecord) return
  const u = usage.value
  const cost = dollars.value
  chatRecord = {
    ...chatRecord,
    turns: chatRecord.turns + 1,
    tokensIn: u.input + u.cacheRead + u.cacheWrite,
    tokensOut: u.output,
    runs: items.value.filter((x) => x.kind === 'run' && !x.resumed).length,
    ...(cost === undefined ? {} : { cost }),
  }
  chatLog.value = recordChat(chatLog.value, chatRecord)
  store(CHATS, JSON.stringify(chatLog.value))
}
/** Stops the run at once, whatever it's waiting on (runAgent races every step against the signal). */
function stop() {
  answerPending?.({ button: STOPPED, values: {} })
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
  forgetChat(host)
  items.value = []
  usage.value = emptyUsage()
  session = null
  chatProfile.value = null
  chatRecord = null
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
/** The chat's cost so far: its tokens at list prices plus its scout and scraper runs. */
const dollars = computed(() => {
  const tokens = chatCost(usage.value, (chatProfile.value ?? nextProfile.value).models.assistant)
  const runs = items.value.reduce((sum, x) => sum + (x.kind === 'run' && !x.resumed ? (x.result?.cost ?? 0) : 0), 0)
  return tokens === undefined ? undefined : tokens + runs
})
const usageText = computed(() => {
  const u = usage.value
  const inTotal = u.input + u.cacheRead + u.cacheWrite
  if (!inTotal && !u.output) return ''
  const cost = dollars.value === undefined ? '' : ` · ≈ $${dollars.value < 0.995 ? dollars.value.toFixed(2) : dollars.value.toFixed(dollars.value < 10 ? 2 : 1)}`
  return `${k(inTotal)} in${u.cacheRead ? ` (${k(u.cacheRead)} cached)` : ''} · ${k(u.output)} out${cost}`
})
</script>

<template>
  <aside class="assistant" aria-label="Assistant">
    <header>
      <div class="title">
        <span class="eyebrow">Assistant</span>
        <strong>Dataset processor</strong>
        <span class="muted small" data-testid="agent.profile">{{ (chatProfile ?? nextProfile).label }} · {{ labelOf((chatProfile ?? nextProfile).models.assistant) }}</span>
      </div>
      <UiButton size="compact" title="Clear this conversation and start over" :disabled="!items.length" @click="newChat(true)">New chat</UiButton>
      <UiButton size="compact" icon="⚙" :active="settings" :aria-pressed="settings" title="API key and profile" aria-label="Settings: API key and profile" @click="settings = !settings" />
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
      <fieldset class="profiles">
        <legend>Profile</legend>
        <p class="muted small">Which model does each job: the chat itself, the scout (finds data on the web), the scraper (fetches it) and the reviewer (checks the work; coming).</p>
        <label v-for="p in PROFILES" :key="p.id" class="profile" :class="{ on: p.id === profileId }" :data-testid="`profile.${p.id}`">
          <input v-model="profileId" type="radio" name="agent-profile" :value="p.id" />
          <span class="p-text">
            <b>{{ p.label }}</b> <span class="muted">· {{ p.note }}</span>
            <span class="muted small p-models">{{ modelsLine(p) }}</span>
            <span v-if="stats[p.id]" class="muted small">{{ statsLine(stats[p.id]) }} on this device</span>
          </span>
        </label>
        <p class="muted small">Prices are list prices (Haiku $0.10 / $0.50, Sonnet $2 / $10, Opus $4 / $20 per million tokens in / out). A chat keeps the profile it started with.</p>
      </fieldset>
      <div v-if="chatProfile && chatProfile.id !== profileId" class="switch">
        <span>This chat uses {{ chatProfile.label }}; {{ nextProfile.label }} applies to the next one.</span>
        <UiButton size="compact" :disabled="busy" @click="newChat()">Start a new chat</UiButton>
      </div>
      <details v-if="apiKey" class="lab-wrap">
        <summary>Test: scout &amp; scraper (proof of concept)</summary>
        <LabPanel :api-key="apiKey" :models="nextProfile.models" :host="props.host" />
      </details>
    </section>

    <div ref="scroller" class="chat">
      <div v-if="!items.length" class="empty">
        <p>Ask for data to be found, prepared or shown, for example:</p>
        <p class="ex">“Map the median rent per county, and per state.”</p>
        <p class="ex">“How many new nursing jobs were posted per state last week?”</p>
        <p class="muted small">
          It starts from your workspace and says how well your datasets fit. When something's missing it can, if you agree, send a <b>scout</b> to find
          data on the web and a <b>scraper</b> to fetch it (signed in; each run has a spending cap you approve). Then it writes transforms and sets up
          visualizations. Its edits are unsaved until you Save.
        </p>
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
            <span class="name">{{ toolLabel(it.call) }}</span>
            <span class="sum">{{ it.summary }}</span>
          </button>
          <div v-if="it.open" class="detail">
            <pre>{{ toolInput(it.call) }}</pre>
            <pre v-if="it.result">{{ it.result.length > 4000 ? `${it.result.slice(0, 4000)}…` : it.result }}</pre>
          </div>
        </div>
        <AskCard v-else-if="it.kind === 'ask'" :form="it.form" :answer="it.answer" @answer="(a) => answerPending?.(a)" />
        <div v-else-if="it.kind === 'run'" class="tool run" :class="it.state" data-testid="web-run">
          <button class="tool-line" :aria-expanded="it.open" @click="it.open = !it.open">
            <span class="dot" aria-hidden="true">{{ it.state === 'running' ? '…' : it.state === 'ok' ? '✓' : '⚠' }}</span>
            <span class="name">{{ ROLE_LABEL[it.role] }}</span>
            <span class="sum">{{ runSummary(it) }}</span>
          </button>
          <div v-if="it.open" class="detail">
            <p class="sub">Brief</p>
            <pre class="prose">{{ it.brief }}</pre>
            <template v-if="it.log.length">
              <p class="sub">Steps</p>
              <ol class="steps">
                <li v-for="(e, j) in it.log" :key="j" :class="`ev-${e.kind}`">{{ e.kind === 'message' ? e.text.split('\n')[0] : e.text }}</li>
              </ol>
            </template>
            <template v-if="it.result?.report">
              <p class="sub">{{ it.role === 'scout' ? 'Report' : 'Summary' }}</p>
              <pre class="prose">{{ it.result.report }}</pre>
            </template>
            <p v-if="it.result?.missing?.length" class="warn-text small">Never came back: {{ it.result.missing.join(', ') }}</p>
            <template v-if="it.result?.files.length">
              <p class="sub">Files</p>
              <ul class="files">
                <li v-for="f in it.result.files" :key="f.id">
                  <span>{{ f.name }}</span>
                  <template v-for="m in it.imported.filter((x) => x.name === f.name)" :key="m.name">
                    <span v-if="m.id" class="ok-text"> → dataset “{{ datasetName(m.id) }}”</span>
                    <span v-else class="warn-text"> → not imported: {{ m.error }}</span>
                  </template>
                  <UiButton size="compact" :aria-label="`Download ${f.name}`" @click="saveRunFile(f)">Download</UiButton>
                </li>
              </ul>
            </template>
            <a v-if="it.sessionId" class="trace" :href="traceUrl(it.sessionId)" target="_blank" rel="noopener">Its full trace in Anthropic's console ↗</a>
          </div>
          <UiButton v-if="it.state === 'running'" size="compact" class="stop-run" :disabled="it.stop.stopped" @click="stopRun(it)">{{ it.stop.stopped ? 'Stopping…' : 'Stop this run' }}</UiButton>
        </div>
        <div v-else class="note" :class="it.tone">
          <p>{{ it.text }}</p>
          <details v-if="it.detail" class="detail-box">
            <summary>Details</summary>
            <pre>{{ it.detail.length > 4000 ? `${it.detail.slice(0, 4000)}…` : it.detail }}</pre>
          </details>
        </div>
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
        <span class="muted small usage" title="Tokens this chat used; ≈ $ at list prices, scout and scraper runs included">{{ usageText }}</span>
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
  /* The chat's three text sizes: everything in the panel (and its cards) uses one of these. */
  --chat-fs: 0.86rem;
  --chat-fs-sm: 0.76rem;
  --chat-fs-xs: 0.7rem;
  font-size: var(--chat-fs);
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
  font-size: var(--chat-fs-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-blue);
}
.settings {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.35rem;
  max-height: 75vh;
  overflow: auto;
  padding: 0.6rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev-2);
}
.settings input,
.settings select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  font: inherit; /* the panel's text size; iOS's zoom-on-focus is turned off in main.ts */
  padding: 0.35rem 0.45rem;
}
.lab-wrap summary {
  cursor: pointer;
  font-size: var(--chat-fs-sm);
  color: var(--text-muted);
}
.profiles {
  display: grid;
  gap: 0.3rem;
  margin: 0.2rem 0 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.profiles legend {
  padding: 0;
  font-weight: 600;
}
.profile {
  display: flex;
  gap: 0.45rem;
  align-items: flex-start;
  padding: 0.35rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}
.profile.on {
  border-color: var(--accent-blue);
}
.profile input {
  margin-top: 0.2rem;
}
.p-text {
  display: grid;
  min-width: 0;
}
.switch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--chat-fs-sm);
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
  font: inherit;
  font-size: var(--chat-fs-sm);
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
  font-size: var(--chat-fs-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.note {
  margin: 0;
  font-size: var(--chat-fs-sm);
}
.note p {
  margin: 0;
}
.detail-box summary {
  cursor: pointer;
  color: var(--text-muted);
  font-size: var(--chat-fs-sm);
}
.detail-box pre {
  margin: 0.25rem 0 0;
  max-height: 10rem;
  overflow: auto;
  padding: 0.35rem;
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--text-muted);
  font-size: var(--chat-fs-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
.run .detail {
  margin-top: 0.15rem;
}
.sub {
  margin: 0;
  font-size: var(--chat-fs-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.steps,
.files {
  margin: 0;
  padding-left: 1.2rem;
  max-height: 12rem;
  overflow: auto;
  font-size: var(--chat-fs-xs);
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.detail pre.prose {
  font-family: inherit;
  font-size: var(--chat-fs-sm);
}
.steps .ev-message {
  color: var(--text);
}
.steps .ev-error {
  color: var(--warn);
}
.files {
  max-height: none;
  font-size: var(--chat-fs-sm);
  color: var(--text);
}
.files li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0;
}
.ok-text {
  color: var(--ok);
}
.warn-text {
  color: var(--warn);
}
.trace {
  font-size: var(--chat-fs-sm);
}
.stop-run {
  margin-top: 0.25rem;
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
  font-size: var(--chat-fs-sm);
  margin: 0;
}
</style>

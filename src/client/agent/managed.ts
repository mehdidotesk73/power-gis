// Scout and scraper sessions on Anthropic Managed Agents (proof of concept).
// The agent loop runs on Anthropic's side and its tools (bash, Python, web
// search / fetch) in a container there, so a run doesn't depend on this page
// staying awake. Those endpoints refuse calls straight from a web page (CORS),
// so the calls go through our relay, a Supabase Edge Function
// (supabase/functions/managed-relay) that forwards them with the user's own
// key and stores nothing. The page polls the session's events (short calls a
// relay can carry) instead of holding a stream open.
//
// Roles (docs/agents.md): the in-app assistant orchestrates; the scout looks
// around broad and shallow and reports; the scraper follows a precise brief,
// digs deep and writes CSVs to /mnt/session/outputs/. Both have unrestricted
// web access for now (data often lives on another platform than the site that
// points to it). Every run has a hard spending cap (a session budget).

import Anthropic from '@anthropic-ai/sdk'
import { SUPABASE_KEY, SUPABASE_URL } from '../../shared/supabaseConfig'
import { supabase } from '../supabase'
import { ensureSetup, forgetSetup, keyHash, type Account, type Setup } from './provision'

export type Role = 'scout' | 'scraper'

const FALLBACK_LADDER = `If a page can't be read with web_fetch (blocked, or empty because JavaScript builds it), fetch the same URL from a Python script in the container (requests, with a normal browser User-Agent); if the content only appears after JavaScript runs, try a headless browser from Python (pip install playwright, then playwright install chromium). This container's network path re-signs TLS certificates with its own certificate authority: Python's requests already trusts it, Chromium doesn't until you add it. Before launching, find the CA bundle Python trusts (the REQUESTS_CA_BUNDLE or SSL_CERT_FILE environment variable, else /etc/ssl/certs/ca-certificates.crt) and import its certificates into Chromium's NSS database (apt-get install -y libnss3-tools; certutil -d sql:$HOME/.pki/nssdb -N --empty-password < /dev/null; then for each certificate split out of the bundle: timeout 10 certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n <name> -i <file> < /dev/null — certutil can wait forever on a prompt otherwise; the whole bundle takes a few seconds). Keep certificate checks on: never disable TLS verification. In general, give any command that might wait for input or the network a timeout and no stdin, so one stuck step can't eat the run. If it's still blocked, report it as blocked with the reason instead of retrying. Keep requests polite (a few per site, no hammering) and respect the site's terms.`

export const ROLE_PROMPTS: Record<Role, string> = {
  scout: `You are a data scout. You get a brief to explore, broad and shallow: find out what data exists, where, and in what form. The brief lists its needs; work through them one by one, and stop on a need once it has one good source (two when you aren't sure which is better, or when one only partly covers it): a good-enough source found is worth more than a long search for the best one. Search, open the likely pages, follow links to where the data actually lives (it is often on another platform than the site that points to it), and look at each dataset lightly: its format (HTML table, CSV, Excel, PDF, API), its coverage (years, areas), how to get it, and its terms of use (read the terms page itself when there is one).
Peek, don't guess: for each distinct kind of file, download one (if it is under about 20 MB) in the container and read only its layout with Python: sheet names, the header rows, column names and the first 5 rows (CSV / Excel), or the page count and which pages hold tables plus one table's header (PDF). Report the layout you saw, not what file names suggest. Never extract or save a whole dataset; nothing goes to /mnt/session/outputs/.
${FALLBACK_LADDER}
Finish with a short report, as your last message, in plain text: one entry per source with the URL, what it holds and exactly what it measures (units, money basis such as market exchange rates or purchasing power, mean or median, per year or month, period), format and the layout you saw, coverage (which places, at which unit, which years), how to get it, terms, and how confident you are. When candidates for the same need measure different things, say so plainly, and how they could be combined (one anchoring, another filling in, calibrated where both have data). Then what you could not find or reach.
End with one line that starts with SOURCES: followed by JSON on that same line, so the app can keep what you found: {"needs":[{"need":"<the need as the brief names it>","sources":[{"name":"…","url":"…","measures":"<exactly what: units, money basis, mean or median, per year or month>","coverage":"<which places, at which unit>","period":"…","access":"<how to get it, and the layout you saw>","terms":"…","confidence":"high|medium|low"}],"combination":"<how sources for this need could be combined, or omit>","boundaries":"<where the shapes for the unit are, when they are needed, or omit>"}]}`,
  scraper: `You are a data scraper. You get a precise brief: which sources to read, what to extract, and the columns of the result. Write Python in the container (pandas is a pip install away; use pdfplumber for PDFs, pandas.read_html for HTML tables) and run it to fetch, parse and combine the data into the requested table(s). Keep the source's units and scales (thousands, millions, percent) unless the brief asks for others, and state each value column's unit in your final message. Check your result: row counts, one row per key where the brief expects it, totals against the source's own totals where it has them, no columns empty by mistake.
${FALLBACK_LADDER}
Accuracy: keys and identifiers (codes, FIPS, ids, names you join on) must be exact: never substitute or guess them. For values, follow the brief's tolerance for each measure (which substitutes it accepts: a nearby year, another source, an estimate; how much error). Where the brief says nothing, a close substitute with an obviously small error is fine (an adjacent year for a slow-moving figure such as population) and better than an empty cell; anything more is left empty. Mark every substituted value on its row (a source_year or note column) and list the substitutions in your report; never substitute silently.
Save each result as a UTF-8 CSV with a header row in /mnt/session/outputs/ (keep codes such as FIPS as text with their leading zeros); shapes go in a geometry column as GeoJSON text (lon/lat), or as a .geojson FeatureCollection. Save the final script there as well (script.py). Finish with a short message: each file, its rows and columns, its sources (URLs), any substitutions, and anything that didn't match the brief. Its last line lists every file you saved, exactly like this: FILES: name1.csv, name2.csv, script.py`,
}

/** The container: one cloud environment with unrestricted egress (agreed for both roles for now). */
const ENV_CONFIG = { type: 'cloud' as const, networking: { type: 'unrestricted' as const } }

/** The agents' tools: the full built-in toolset, every action allowed (they run in their own sandbox). */
const TOOLS = [{ type: 'agent_toolset_20260401', default_config: { enabled: true, permission_policy: { type: 'auto' } } }]

/** The relay (supabase/functions/managed-relay): the SDK's requests, sent to it instead of api.anthropic.com. */
export const RELAY_URL = `${SUPABASE_URL}/functions/v1/managed-relay`

/** The relay is for signed-in users: without a session, nothing is sent. */
export class SignInNeeded extends Error {
  constructor() {
    super('Sign in (☰ → Sign in) to send the scout or the scraper: they reach Anthropic through our relay, which is for signed-in users.')
  }
}

/** The relay's own refusals (it answers 401 for a missing / expired sign-in, before Anthropic is reached). */
const RELAY_SIGN_IN = /Sign in to PowerGIS to use the relay/
const RELAY_NO_KEY = /No Anthropic key reached the relay/

/** The signed-in user's current access token (refreshed when `fresh`), or null when signed out. */
async function accessToken(fresh = false): Promise<string | null> {
  if (fresh) {
    const r = await supabase.auth.refreshSession()
    if (r.data.session?.access_token) return r.data.session.access_token
  }
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/**
 * An SDK client that talks to the relay as the signed-in user. Every request carries the session's
 * current token (a run lasts minutes; the token it started with can expire, or be replaced when the
 * phone wakes), and one the relay refuses for sign-in is sent once more with a refreshed token.
 */
export async function client(apiKey: string): Promise<Anthropic> {
  if (!(await accessToken())) throw new SignInNeeded()
  const withToken = async (input: RequestInfo | URL, init: RequestInit | undefined, fresh: boolean) => {
    const token = await accessToken(fresh)
    if (!token) throw new SignInNeeded()
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers })
  }
  // The key also goes in x-relay-key: Supabase's hosted gateway doesn't pass the SDK's x-api-key on.
  return new Anthropic({
    apiKey,
    baseURL: RELAY_URL,
    defaultHeaders: { apikey: SUPABASE_KEY, 'x-relay-key': apiKey },
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await withToken(input, init, false)
      if (res.status !== 401) return res
      const body = await res.clone().text()
      return RELAY_SIGN_IN.test(body) ? withToken(input, init, true) : res
    },
  })
}

// ── what went wrong, and where ─────────────────────────────────────────────

/** Where a run's call failed: starting it, following it, collecting its results, or downloading a file. */
export type RunPhase = 'launch' | 'follow' | 'results' | 'download'
/** Why: the PowerGIS sign-in (the relay refused), the Anthropic key (Anthropic refused), the network, or something else. */
export type RunCause = 'sign-in' | 'key' | 'network' | 'other'

/** A run's call that failed, with what's known: where, why, and the run (its session id) when there is one. */
export class RunError extends Error {
  constructor(
    readonly phase: RunPhase,
    readonly cause: RunCause,
    readonly detail: string,
    readonly sessionId?: string,
  ) {
    super(runErrorText(phase, cause, detail, sessionId))
  }
}

/** What a failed call means, from the error the SDK or the relay gave. */
export function causeOf(e: unknown): { cause: RunCause; detail: string } {
  if (e instanceof SignInNeeded) return { cause: 'sign-in', detail: e.message }
  const msg = e instanceof Error ? e.message : String(e)
  const status = (e as { status?: number })?.status
  if (RELAY_SIGN_IN.test(msg)) return { cause: 'sign-in', detail: 'the relay refused the PowerGIS sign-in (expired or missing session)' }
  if (RELAY_NO_KEY.test(msg)) return { cause: 'key', detail: 'no Anthropic key reached the relay' }
  if (status === 401 || status === 403) return { cause: 'key', detail: `Anthropic refused the key (${status}): ${msg.slice(0, 200)}` }
  if (e instanceof Anthropic.APIConnectionError || /network|fetch|Load failed|timed? ?out/i.test(msg)) return { cause: 'network', detail: msg.slice(0, 200) }
  return { cause: 'other', detail: `${status ? `${status}: ` : ''}${msg.slice(0, 300)}` }
}

const PHASE_TEXT: Record<RunPhase, string> = {
  launch: 'starting the run',
  follow: 'following the run',
  results: "collecting the run's results",
  download: 'downloading a file of the run',
}
const CAUSE_TEXT: Record<RunCause, string> = {
  'sign-in': 'your PowerGIS sign-in was refused by the relay (sign in again: ☰ → Sign in)',
  key: 'the Anthropic API key was refused (check it in the assistant settings, ⚙)',
  network: 'the network dropped',
  other: 'an unexpected error',
}
function runErrorText(phase: RunPhase, cause: RunCause, detail: string, sessionId?: string): string {
  const state =
    phase === 'launch'
      ? sessionId
        ? 'The run may have started.'
        : 'The run did not start (nothing was spent).'
      : 'The run carries on, or has finished, on Anthropic’s side: nothing is lost — fetch its results later with its id.'
  return `Failed while ${PHASE_TEXT[phase]}: ${CAUSE_TEXT[cause]}. ${state}${sessionId ? ` Run id: ${sessionId}.` : ''} (${detail})`
}

/** Wraps a failure as a RunError for its phase (one already wrapped is passed on). */
export function asRunError(e: unknown, phase: RunPhase, sessionId?: string): RunError {
  if (e instanceof RunError) return e
  const { cause, detail } = causeOf(e)
  return new RunError(phase, cause, detail, sessionId)
}

/** Retries `f` while it fails for a reason that can pass (the network, a refused sign-in): a few times, waiting longer each time. */
async function patiently<T>(f: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f()
    } catch (e) {
      const { cause } = causeOf(e)
      if (i + 1 >= tries || (cause !== 'network' && cause !== 'sign-in')) throw e
      await pause(1000 * 2 ** i)
    }
  }
}

// ── the run in progress (this device) ──────────────────────────────────────
// A run carries on on Anthropic's side whatever happens to the page; remembered
// here, it's picked up again (progress, results, the scraper's CSVs) after a
// reload.

const ACTIVE = 'powergis.webRun'
export interface ActiveRun {
  sessionId: string
  role: Role
  brief: string
  startedAt: number
}
export function activeRun(): ActiveRun | null {
  try {
    const r = JSON.parse(localStorage.getItem(ACTIVE) ?? 'null') as ActiveRun | null
    return r && typeof r.sessionId === 'string' ? r : null
  } catch {
    return null
  }
}
function remember(r: ActiveRun | null) {
  try {
    if (r) localStorage.setItem(ACTIVE, JSON.stringify(r))
    else localStorage.removeItem(ACTIVE)
  } catch {
    /* not resumable after a reload, that's all */
  }
}
/** Forgets the run in progress (it finished and its results were taken care of). */
export const forgetRun = () => remember(null)

// ── recent runs (this device): what was sent, how it ended, so a run can be found and fetched later ──

const RUNS = 'powergis.webRuns'
export interface RunLog {
  sessionId: string
  role: Role
  brief: string
  startedAt: number
  state: 'running' | 'finished' | 'failed' | 'stopped'
  error?: string
  cost?: number
  files?: string[]
}
export function recentRuns(): RunLog[] {
  try {
    const v = JSON.parse(localStorage.getItem(RUNS) ?? '[]')
    return Array.isArray(v) ? (v as RunLog[]) : []
  } catch {
    return []
  }
}
/** Records (or updates) a run in this device's list of recent runs (the 30 latest). */
export function logRun(entry: Partial<RunLog> & { sessionId: string }) {
  const all = recentRuns()
  const was = all.find((x) => x.sessionId === entry.sessionId)
  const next = { ...(was ?? { role: 'scraper', brief: '', startedAt: Date.now(), state: 'running' }), ...entry } as RunLog
  try {
    localStorage.setItem(RUNS, JSON.stringify([next, ...all.filter((x) => x.sessionId !== entry.sessionId)].slice(0, 30)))
  } catch {
    /* a convenience */
  }
}

/** Ids this browser remembered that the account no longer has (archived or deleted there). */
function staleSetup(e: unknown): boolean {
  const status = (e as { status?: number })?.status
  const msg = String((e as { message?: string })?.message ?? e)
  return status === 404 || ((status === 400 || status === 409) && /archiv|not found|does not exist/i.test(msg))
}

export interface RunEvent {
  kind: 'status' | 'message' | 'tool' | 'result' | 'error' | 'ask'
  text: string
  /** For `ask`: the session and the event to confirm or deny. */
  id?: string
  session?: string
}
export interface OutputFile {
  id: string
  name: string
  bytes: number
}
export interface RunResult {
  sessionId: string
  /** The agent's last message (the report / the summary). */
  report: string
  files: OutputFile[]
  /** Files the report names that never came back. */
  missing?: string[]
  /** Cost at list prices, in dollars, and seconds the session was active. */
  cost?: number
  activeSeconds?: number
  elapsedSeconds: number
  stop: string
}

const clip = (t: string, n = 200) => (t.length > n ? `${t.slice(0, n)}…` : t)

/**
 * One tool call as a log line: the URL or query on its own (so a phone links
 * the URL alone, not the JSON's quote and brace after it), else the command's
 * first line, else the input as JSON.
 */
export function describeTool(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  if (str('url')) return `${name} ${str('url')}`
  if (str('query')) return `${name} “${clip(str('query')!)}”`
  if (str('command')) {
    const lines = str('command')!.trim().split('\n')
    return `${name}: ${clip(lines[0])}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ''}`
  }
  if (str('file_path')) return `${name} ${str('file_path')}`
  return `${name} ${clip(JSON.stringify(i))}`
}

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((b) => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : '')).join('') : ''

/**
 * Starts one brief: a new session with a spending cap (dollars) and the brief
 * sent. Remembered on this device until forgetRun. Then followRun.
 */
export async function startRun(apiKey: string, opts: { role: Role; model: string; brief: string; capDollars: number }): Promise<ActiveRun> {
  let sessionId: string | undefined
  try {
    const c = await client(apiKey)
    // The account's own agent for this role (found by its tag, made or updated if needed: provision.ts); the model is this run's.
    const key = await keyHash(apiKey)
    const def = { role: opts.role, system: ROLE_PROMPTS[opts.role], model: opts.model, tools: TOOLS }
    const account = c as unknown as Account
    const open = ({ environmentId, agent }: Setup) =>
      c.beta.sessions.create({
        agent: { type: 'agent_with_overrides', id: agent.id, version: agent.version, model: opts.model },
        environment_id: environmentId,
        title: `PowerGIS ${opts.role}`,
        budget: { type: 'limit', max_list_cost: { amount: String(Math.round(opts.capDollars * 100)), currency: 'USD' } },
      })
    let session: Awaited<ReturnType<typeof open>>
    try {
      session = await open(await ensureSetup(account, key, def, ENV_CONFIG))
    } catch (e) {
      if (!staleSetup(e)) throw e
      forgetSetup(key) // remembered ids the account no longer has: look again, once
      session = await open(await ensureSetup(account, key, def, ENV_CONFIG))
    }
    sessionId = session.id
    // Remembered before the brief is sent: from here on the run can always be found again by its id.
    const run: ActiveRun = { sessionId: session.id, role: opts.role, brief: opts.brief, startedAt: Date.now() }
    remember(run)
    logRun({ ...run, state: 'running' })
    await patiently(() => c.beta.sessions.events.send(session.id, { events: [{ type: 'user.message', content: [{ type: 'text', text: opts.brief }] }] }))
    return run
  } catch (e) {
    throw asRunError(e, 'launch', sessionId)
  }
}

/**
 * Follows a started run to its end: its events every few seconds (from the
 * start, so a run picked up after a reload shows its whole log), then its
 * usage and output files. `onEvent` gets progress; an `ask` event waits for
 * `confirm`. Stopping (`signal`) interrupts the session.
 */
export async function followRun(
  apiKey: string,
  run: ActiveRun,
  opts: { onEvent: (e: RunEvent) => void; signal?: { stopped: boolean } | AbortSignal },
): Promise<RunResult> {
  const c = await client(apiKey).catch((e) => Promise.reject(asRunError(e, 'follow', run.sessionId)))
  const stopped = () => (opts.signal ? ('aborted' in opts.signal ? opts.signal.aborted : opts.signal.stopped) : false)
  let report = ''
  let stop = 'unknown'
  // New events every few seconds: those at or after the last one seen, minus the ones already handled.
  const seen = new Set<string>()
  let since: string | undefined
  let quiet = 0
  // An idle status counts only once the agent has started on the brief (a new session may report idle first).
  let begun = false
  poll: for (;;) {
    if (stopped()) {
      await c.beta.sessions.events.send(run.sessionId, { events: [{ type: 'user.interrupt' }] }).catch(() => undefined)
      stop = 'stopped'
      break
    }
    let page
    try {
      page = await c.beta.sessions.events.list(run.sessionId, { order: 'asc', limit: 100, ...(since ? { 'created_at[gte]': since } : {}) })
    } catch (e) {
      // A network blip (the phone slept, the network changed) or a sign-in that lapsed: the session
      // carries on; ask again, waiting a little longer each time. A refused key won't pass by waiting.
      const { cause, detail } = causeOf(e)
      if (cause === 'key' || cause === 'other' || ++quiet > 20) throw asRunError(e, 'follow', run.sessionId)
      opts.onEvent({ kind: 'status', text: `Lost touch (${cause}: ${detail}); trying again…` })
      await pause(Math.min(30_000, 2000 * quiet))
      continue
    }
    quiet = 0
    for (const ev of page.data) {
      if (seen.has(ev.id)) continue
      seen.add(ev.id)
      since = ev.processed_at ?? since
      if (ev.type === 'session.status_running' || ev.type.startsWith('agent.')) begun = true
      switch (ev.type) {
        case 'agent.message': {
          const t = textOf(ev.content)
          if (t.trim()) {
            report = t
            opts.onEvent({ kind: 'message', text: t })
          }
          break
        }
        case 'agent.tool_use': {
          const input = JSON.stringify(ev.input ?? {})
          opts.onEvent({ kind: 'tool', text: describeTool(ev.name, ev.input) })
          if (ev.evaluated_permission === 'ask') opts.onEvent({ kind: 'ask', text: `Allow ${ev.name}? ${input.slice(0, 400)}`, id: ev.id, session: run.sessionId })
          break
        }
        case 'session.error':
          opts.onEvent({ kind: 'error', text: JSON.stringify(ev.error) })
          break
        case 'session.status_idle': {
          const reason = ev.stop_reason?.type ?? 'end_turn'
          if (!begun || reason === 'requires_action') break // not started yet, or waiting on a confirmation: keep polling
          stop = reason
          break poll
        }
        case 'session.status_terminated':
          stop = 'terminated'
          break poll
      }
    }
    // A full page means more are waiting: read on at once.
    if (page.data.length < 100) await pause(3000)
  }

  let after, outputs
  try {
    after = await patiently(() => c.beta.sessions.retrieve(run.sessionId))
    const expected = expectedFiles(report)
    let told = false
    outputs = await outputFiles(c, run.sessionId, expected, (m) => {
      if (!told) opts.onEvent({ kind: 'status', text: `Waiting for ${m.length === 1 ? m[0] : `${m.length} files`} to come back…` })
      told = true
    })
  } catch (e) {
    throw asRunError(e, 'results', run.sessionId)
  }
  const usage = after.usage as { list_cost?: { amount: string }; active_seconds?: number } | undefined
  const { files, missing } = outputs
  return {
    sessionId: run.sessionId,
    report: withoutFilesLine(report),
    files,
    ...(missing.length ? { missing } : {}),
    ...(usage?.list_cost ? { cost: Number(usage.list_cost.amount) / 100 } : {}),
    ...(usage?.active_seconds !== undefined ? { activeSeconds: usage.active_seconds } : {}),
    elapsedSeconds: Math.round((Date.now() - run.startedAt) / 1000),
    stop,
  }
}

/** Starts a brief and follows it to the end (the test panel). */
export async function runBrief(
  apiKey: string,
  opts: { role: Role; model: string; brief: string; capDollars: number; onEvent: (e: RunEvent) => void; signal?: { stopped: boolean } },
): Promise<RunResult> {
  const run = await startRun(apiKey, opts)
  opts.onEvent({ kind: 'status', text: `Session ${run.sessionId} started` })
  try {
    return await followRun(apiKey, run, opts)
  } finally {
    forgetRun()
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The files the session wrote to /mnt/session/outputs/ (they appear a moment after it stops). */
/** The files a run says it saved: its report's last "FILES: a.csv, b.csv" line (none when it has no such line). */
export function expectedFiles(report: string): string[] {
  const line = [...report.matchAll(/^\s*\**FILES:\**\s*(.*)$/gim)].pop()?.[1] ?? ''
  return line
    .split(',')
    .map((f) => f.trim().replace(/^`|`$/g, '').split('/').pop()!.trim())
    .filter((f) => f && !/^none$/i.test(f))
}
/** The report without its FILES line (it's for the app). */
export const withoutFilesLine = (report: string) => report.replace(/\n?^\s*\**FILES:\**.*$/gim, '').trimEnd()

/**
 * The files the session wrote to /mnt/session/outputs/. They appear one by one
 * after it stops: wait until every file its report names is there (up to a
 * couple of minutes; then say which never came), else until the list holds still.
 */
async function outputFiles(c: Anthropic, sessionId: string, expected: string[], onWait?: (missing: string[]) => void): Promise<{ files: OutputFile[]; missing: string[] }> {
  const deadline = Date.now() + (expected.length ? 120_000 : 6_000)
  let last = -1
  for (;;) {
    const page = await patiently(() => c.beta.files.list({ scope_id: sessionId, limit: 100, betas: ['managed-agents-2026-04-01'] }))
    const files = page.data.map((f) => ({ id: f.id, name: f.filename, bytes: f.size_bytes }))
    const missing = expected.filter((n) => !files.some((f) => f.name === n))
    if (expected.length ? !missing.length : files.length && files.length === last) return { files, missing }
    if (Date.now() > deadline) return { files, missing }
    if (missing.length) onWait?.(missing)
    last = files.length
    await pause(3000)
  }
}

/** A run as Anthropic keeps it, read back by its id: its status, cost, what happened (condensed) and its files. */
export interface RunTrace {
  sessionId: string
  /** The session's status now (running, idle, terminated…). */
  status: string
  /** How it last stopped, when it has (end_turn, max_tokens, an error…). */
  stop?: string
  cost?: number
  activeSeconds?: number
  /** In order: status changes, the agent's tool calls and messages, errors. */
  events: { at?: string; kind: 'status' | 'message' | 'tool' | 'error'; text: string }[]
  /** Events left out from the middle (the first and last ones are kept). */
  omitted: number
  /** The agent's last message (its report or summary), whole. */
  lastMessage?: string
  files: OutputFile[]
}

/**
 * Reads a run back by its id without changing anything (nothing is sent to it, nothing imported):
 * the back channel when the app lost touch with a run — where it got to, what failed and why.
 */
export async function readRun(apiKey: string, sessionId: string, opts: { maxEvents?: number } = {}): Promise<RunTrace> {
  const max = opts.maxEvents ?? 160
  try {
    const c = await client(apiKey)
    const session = (await patiently(() => c.beta.sessions.retrieve(sessionId))) as unknown as { status?: string; usage?: { list_cost?: { amount: string }; active_seconds?: number } }
    const events: RunTrace['events'] = []
    let lastMessage: string | undefined
    let stop: string | undefined
    const seen = new Set<string>()
    let since: string | undefined
    for (let pages = 0; pages < 50; pages++) {
      const page = await patiently(() => c.beta.sessions.events.list(sessionId, { order: 'asc', limit: 100, ...(since ? { 'created_at[gte]': since } : {}) }))
      let fresh = 0
      for (const ev of page.data) {
        if (seen.has(ev.id)) continue
        seen.add(ev.id)
        fresh++
        since = ev.processed_at ?? since
        const at = ev.processed_at ?? undefined
        const e = ev as unknown as { type: string; content?: unknown; name?: string; input?: unknown; error?: unknown; stop_reason?: { type?: string }; is_error?: boolean }
        if (e.type === 'agent.message') {
          const t = textOf(e.content)
          if (t.trim()) (lastMessage = t), events.push({ at, kind: 'message', text: clip(t, 600) })
        } else if (e.type === 'agent.tool_use') events.push({ at, kind: 'tool', text: describeTool(e.name ?? 'tool', e.input) })
        else if (e.type === 'agent.tool_result' && e.is_error) events.push({ at, kind: 'error', text: `tool failed: ${clip(textOf(e.content) || JSON.stringify(e.content ?? ''), 400)}` })
        else if (e.type === 'session.error') events.push({ at, kind: 'error', text: clip(JSON.stringify(e.error), 600) })
        else if (e.type.startsWith('session.status_')) {
          const s = e.type.slice('session.status_'.length)
          if (s === 'idle' && e.stop_reason?.type) stop = e.stop_reason.type
          else if (s === 'terminated') stop = 'terminated'
          events.push({ at, kind: 'status', text: `${s}${e.stop_reason?.type ? ` (${e.stop_reason.type})` : ''}` })
        }
      }
      if (page.data.length < 100 || !fresh) break
    }
    const files = (await patiently(() => c.beta.files.list({ scope_id: sessionId, limit: 100, betas: ['managed-agents-2026-04-01'] }))).data.map((f) => ({ id: f.id, name: f.filename, bytes: f.size_bytes }))
    const keepHead = Math.floor(max / 4)
    const omitted = Math.max(0, events.length - max)
    const kept = omitted ? [...events.slice(0, keepHead), ...events.slice(events.length - (max - keepHead))] : events
    const usage = session.usage
    return {
      sessionId,
      status: session.status ?? 'unknown',
      ...(stop ? { stop } : {}),
      ...(usage?.list_cost ? { cost: Number(usage.list_cost.amount) / 100 } : {}),
      ...(usage?.active_seconds !== undefined ? { activeSeconds: usage.active_seconds } : {}),
      events: kept,
      omitted,
      ...(lastMessage ? { lastMessage } : {}),
      files,
    }
  } catch (e) {
    throw asRunError(e, 'results', sessionId)
  }
}

/** A trace as text, a line per event (the diagnosis and the assistant read it). */
export function traceText(t: RunTrace): string {
  const head = `run ${t.sessionId}: status ${t.status}${t.stop ? `, stopped: ${t.stop}` : ''}${t.cost !== undefined ? `, cost $${t.cost.toFixed(2)}` : ''}${t.activeSeconds !== undefined ? `, active ${t.activeSeconds} s` : ''}`
  const files = `files: ${t.files.map((f) => `${f.name} (${f.bytes} bytes)`).join(', ') || 'none'}`
  const lines = t.events.map((e, i) => `${i === Math.floor(t.events.length / 4) && t.omitted ? `… ${t.omitted} events left out …\n` : ''}${e.at ? `${e.at} ` : ''}[${e.kind}] ${e.text}`)
  return [head, files, ...lines, ...(t.lastMessage ? [`last message:\n${t.lastMessage}`] : [])].join('\n')
}

/** Answers a paused tool call (an `ask` event). */
export async function confirm(apiKey: string, sessionId: string, toolUseId: string, allow: boolean) {
  await (await client(apiKey)).beta.sessions.events.send(sessionId, { events: [{ type: 'user.tool_confirmation', tool_use_id: toolUseId, result: allow ? 'allow' : 'deny' }] })
}

/** One output file's contents. */
export async function downloadFile(apiKey: string, fileId: string, sessionId?: string): Promise<Blob> {
  try {
    const c = await client(apiKey)
    const r = await patiently(() => c.beta.files.download(fileId, { betas: ['managed-agents-2026-04-01'] }))
    return await r.blob()
  } catch (e) {
    throw asRunError(e, 'download', sessionId)
  }
}

/** The live trace of a session in Anthropic's console (Default workspace). */
export const traceUrl = (sessionId: string) => `https://platform.claude.com/workspaces/default/sessions/${sessionId}`

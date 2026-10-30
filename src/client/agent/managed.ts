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

export type Role = 'scout' | 'scraper'

const FALLBACK_LADDER = `If a page can't be read with web_fetch (blocked, or empty because JavaScript builds it), fetch the same URL from a Python script in the container (requests, with a normal browser User-Agent); if the content only appears after JavaScript runs, try a headless browser from Python (pip install playwright, then playwright install chromium). This container's network path re-signs TLS certificates with its own certificate authority: Python's requests already trusts it, Chromium doesn't until you add it. Before launching, find the CA bundle Python trusts (the REQUESTS_CA_BUNDLE or SSL_CERT_FILE environment variable, else /etc/ssl/certs/ca-certificates.crt) and import its certificates into Chromium's NSS database (apt-get install -y libnss3-tools; certutil -d sql:$HOME/.pki/nssdb -N --empty-password < /dev/null; then for each certificate split out of the bundle: timeout 10 certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n <name> -i <file> < /dev/null — certutil can wait forever on a prompt otherwise; the whole bundle takes a few seconds). Keep certificate checks on: never disable TLS verification. In general, give any command that might wait for input or the network a timeout and no stdin, so one stuck step can't eat the run. If it's still blocked, report it as blocked with the reason instead of retrying. Keep requests polite (a few per site, no hammering) and respect the site's terms.`

export const ROLE_PROMPTS: Record<Role, string> = {
  scout: `You are a data scout. You get a brief to explore, broad and shallow: find out what data exists, where, and in what form. Search, open the likely pages, follow links to where the data actually lives (it is often on another platform than the site that points to it), and look at each dataset lightly: its format (HTML table, CSV, Excel, PDF, API), its coverage (years, areas), how to get it, and its terms of use (read the terms page itself when there is one).
Peek, don't guess: for each distinct kind of file, download one (if it is under about 20 MB) in the container and read only its layout with Python: sheet names, the header rows, column names and the first 5 rows (CSV / Excel), or the page count and which pages hold tables plus one table's header (PDF). Report the layout you saw, not what file names suggest. Never extract or save a whole dataset; nothing goes to /mnt/session/outputs/.
${FALLBACK_LADDER}
Finish with a short report, as your last message, in plain text: one entry per source with the URL, what it holds, format and the layout you saw, coverage, how to get it, terms, and how confident you are; then what you could not find or reach.`,
  scraper: `You are a data scraper. You get a precise brief: which sources to read, what to extract, and the columns of the result. Write Python in the container (pandas is a pip install away; use pdfplumber for PDFs, pandas.read_html for HTML tables) and run it to fetch, parse and combine the data into the requested table(s). Keep the source's units and scales (thousands, millions, percent) unless the brief asks for others, and state each value column's unit in your final message. Check your result: row counts, one row per key where the brief expects it, totals against the source's own totals where it has them, no columns empty by mistake.
${FALLBACK_LADDER}
Save each result as a UTF-8 CSV with a header row in /mnt/session/outputs/ (keep codes such as FIPS as text with their leading zeros), and save the final script there as well (script.py). Finish with a short message: each file, its rows and columns, its sources (URLs), and anything that didn't match the brief.`,
}

/** The container: one cloud environment with unrestricted egress (agreed for both roles for now). */
const ENV_CONFIG = { type: 'cloud' as const, networking: { type: 'unrestricted' as const } }

const STORE = 'powergis.managed'
interface Stored {
  environmentId?: string
  agents?: Partial<Record<Role, { id: string; version: number; key: string }>>
}
const readStored = (): Stored => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Stored
  } catch {
    return {}
  }
}
const writeStored = (s: Stored) => {
  try {
    localStorage.setItem(STORE, JSON.stringify(s))
  } catch {
    /* recreated next time */
  }
}

/** The relay (supabase/functions/managed-relay): the SDK's requests, sent to it instead of api.anthropic.com. */
export const RELAY_URL = `${SUPABASE_URL}/functions/v1/managed-relay`

export const client = (apiKey: string) =>
  // The key also goes in x-relay-key: Supabase's hosted gateway doesn't pass the SDK's x-api-key on.
  new Anthropic({ apiKey, baseURL: RELAY_URL, defaultHeaders: { apikey: SUPABASE_KEY, 'x-relay-key': apiKey }, dangerouslyAllowBrowser: true, maxRetries: 2 })

/**
 * The environment and the role's agent, created once and remembered on this
 * device (agents again when their prompt or model changes).
 */
async function setup(c: Anthropic, role: Role, model: string) {
  const stored = readStored()
  if (!stored.environmentId) {
    const env = await c.beta.environments.create({ name: 'powergis-data', config: ENV_CONFIG })
    stored.environmentId = env.id
    writeStored(stored)
  }
  const key = `${model}|${ROLE_PROMPTS[role].length}|${ROLE_PROMPTS[role].slice(0, 40)}`
  const have = stored.agents?.[role]
  if (have && have.key === key) return { environmentId: stored.environmentId, agent: have }
  const agent = await c.beta.agents.create({
    name: `powergis-${role}`,
    model,
    system: ROLE_PROMPTS[role],
    tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: true, permission_policy: { type: 'auto' } } }],
  })
  stored.agents = { ...stored.agents, [role]: { id: agent.id, version: agent.version, key } }
  writeStored(stored)
  return { environmentId: stored.environmentId, agent: stored.agents[role]! }
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
 * Runs one brief: a new session with a spending cap (dollars), streamed until
 * the agent stops; then its usage and output files. `onEvent` gets progress;
 * an `ask` event waits for `confirm(id, allow)`.
 */
export async function runBrief(
  apiKey: string,
  opts: { role: Role; model: string; brief: string; capDollars: number; onEvent: (e: RunEvent) => void; signal?: { stopped: boolean } },
): Promise<RunResult> {
  const c = client(apiKey)
  const started = Date.now()
  const { environmentId, agent } = await setup(c, opts.role, opts.model)
  const session = await c.beta.sessions.create({
    agent: { type: 'agent', id: agent.id, version: agent.version },
    environment_id: environmentId,
    title: `PowerGIS ${opts.role}`,
    budget: { type: 'limit', max_list_cost: { amount: String(Math.round(opts.capDollars * 100)), currency: 'USD' } },
  })
  opts.onEvent({ kind: 'status', text: `Session ${session.id} started` })

  let report = ''
  let stop = 'unknown'
  await c.beta.sessions.events.send(session.id, { events: [{ type: 'user.message', content: [{ type: 'text', text: opts.brief }] }] })
  // New events every few seconds: those at or after the last one seen, minus the ones already handled.
  const seen = new Set<string>()
  let since: string | undefined
  let quiet = 0
  // An idle status counts only once the agent has started on the brief (a new session may report idle first).
  let begun = false
  poll: for (;;) {
    if (opts.signal?.stopped) {
      await c.beta.sessions.events.send(session.id, { events: [{ type: 'user.interrupt' }] })
      stop = 'stopped'
      break
    }
    let page
    try {
      page = await c.beta.sessions.events.list(session.id, { order: 'asc', limit: 100, ...(since ? { 'created_at[gte]': since } : {}) })
    } catch (e) {
      // A network blip (the phone slept, the network changed): the session carries on; ask again.
      if (++quiet > 20) throw e
      opts.onEvent({ kind: 'status', text: `Lost touch (${(e as Error).message}); trying again…` })
      await pause(5000)
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
          if (ev.evaluated_permission === 'ask') opts.onEvent({ kind: 'ask', text: `Allow ${ev.name}? ${input.slice(0, 400)}`, id: ev.id, session: session.id })
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

  const after = await c.beta.sessions.retrieve(session.id)
  const usage = after.usage as { list_cost?: { amount: string }; active_seconds?: number } | undefined
  const files = await outputFiles(c, session.id)
  return {
    sessionId: session.id,
    report,
    files,
    ...(usage?.list_cost ? { cost: Number(usage.list_cost.amount) / 100 } : {}),
    ...(usage?.active_seconds !== undefined ? { activeSeconds: usage.active_seconds } : {}),
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    stop,
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The files the session wrote to /mnt/session/outputs/ (they appear a moment after it stops). */
async function outputFiles(c: Anthropic, sessionId: string): Promise<OutputFile[]> {
  for (let i = 0; i < 4; i++) {
    const page = await c.beta.files.list({ scope_id: sessionId, betas: ['managed-agents-2026-04-01'] })
    const files = page.data.map((f) => ({ id: f.id, name: f.filename, bytes: f.size_bytes }))
    if (files.length) return files
    await pause(1500)
  }
  return []
}

/** Answers a paused tool call (an `ask` event). */
export async function confirm(apiKey: string, sessionId: string, toolUseId: string, allow: boolean) {
  await client(apiKey).beta.sessions.events.send(sessionId, { events: [{ type: 'user.tool_confirmation', tool_use_id: toolUseId, result: allow ? 'allow' : 'deny' }] })
}

/** One output file's contents. */
export async function downloadFile(apiKey: string, fileId: string): Promise<Blob> {
  const r = await client(apiKey).beta.files.download(fileId, { betas: ['managed-agents-2026-04-01'] })
  return r.blob()
}

/** The live trace of a session in Anthropic's console (Default workspace). */
export const traceUrl = (sessionId: string) => `https://platform.claude.com/workspaces/default/sessions/${sessionId}`

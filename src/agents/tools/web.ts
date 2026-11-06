// The web: send the scout and the scraper, and pick runs up again by id.
// Each tool: its spec (what the model sees) next to its handler (what runs).

import type { ToolOutcome } from '../../lib/agent/loop'
import type { ToolSpec } from '../../lib/agent/provider'
import { parseScoutReport } from '../../lib/agent/sources'
import { runCard, runOutcome } from '../../lib/agent/exchanges'
import { Obj, PLACEHOLDER, err, isObj, need, ok, plural, str } from './common'
import { AgentHost, CAP_RANGE, WEB_CAPS, WebRole, WebRun } from './host'
import { made } from './workspace'

export const WEB_TOOLS: ToolSpec[] = [
  {
    name: 'send_scout',
    description:
      "Send the scout to find out what data exists on the web: it searches, follows links to where data actually lives, peeks at files' layouts, reads terms of use, and reports back (it extracts nothing). It runs in a container on Anthropic's servers, takes a minute or a few and costs cents. The user approves (and may edit) the brief and the spending cap first. Check list_datasets first (descriptions, sources, caveats, a sample with query_sql): a dataset that is exactly the data needed is used instead. Keep each run narrow: one need, or a few related ones, listed in \"needs\" (each with its measure, unit and window, and posture); the scout stops once each need has one good source (two when it isn't sure). Returns its report and the sources it found per need.",
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'The question and anything the needs don\'t say: candidate sources, what is already known and ruled out, the shapes for the unit if none is built in.' },
        needs: {
          type: 'array',
          description: 'What to find, one entry per need (a few related ones per run at most).',
          items: {
            type: 'object',
            properties: {
              need: { type: 'string', description: 'In a few words ("average annual wage per country").' },
              measure: { type: 'string', description: 'Exactly what: units, money basis, mean or median, per year or month.' },
              where: { type: 'string', description: 'The window and unit of analysis ("every country, latest year").' },
              posture: { type: 'string', enum: ['exact', 'anchor + proxy', 'fermi'], description: 'exact: data at the unit; anchor + proxy: a coarser anchor and finer signals; fermi: inputs for an estimate.' },
            },
            required: ['need', 'measure', 'where', 'posture'],
          },
        },
        cap_dollars: { type: 'number', description: `The spending cap you recommend, in dollars (${CAP_RANGE.min}–${CAP_RANGE.max}): what you expect the run to cost, times a safety factor of about 2 (a scout: about $0.20–0.50 a need; a scraper: about $0.50–1.50 a source, more for PDFs or pages built by JavaScript). Default 1.` },
        cap_reason: { type: 'string', description: 'A few words on how you sized it ("3 sources, PDFs; ×2"), shown on the card; "" for none.' },
      },
      required: ['brief'],
    },
  },
  {
    name: 'send_scraper',
    description:
      "Send the scraper to fetch data from the web into CSV tables: it writes and runs Python in a container on Anthropic's servers (downloads, Excel, PDF tables, pages built by JavaScript), checks its result, and returns CSVs that are added to the workspace as new datasets, plus its script. Takes a few minutes and costs cents. The user approves (and may edit) the brief and the spending cap first. Returns its summary and each file's dataset id.",
    inputSchema: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: "Precise: which sources (URLs), what to extract, and for each output CSV its file name and columns (with units and key formats, e.g. fips as 5-digit text), one row per what. Everything it needs: it can't ask you.",
        },
        cap_dollars: { type: 'number', description: `The spending cap you recommend, in dollars (${CAP_RANGE.min}–${CAP_RANGE.max}): what you expect the run to cost, times a safety factor of about 2 (a scout: about $0.20–0.50 a source; a scraper: about $0.50–1.50 a source, more for PDFs or pages built by JavaScript). Default 2.` },
        cap_reason: { type: 'string', description: 'A few words on how you sized it ("3 sources, PDFs; ×2"), shown on the card; "" for none.' },
      },
      required: ['brief'],
    },
  },
  {
    name: 'list_runs',
    description:
      'The scout and scraper runs started on this device lately (newest first): run id, role, brief (start), when, how it ended (finished, failed with why, stopped, still running), cost and files. Use it to find a run whose results never arrived.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fetch_run',
    description:
      "Collect a scout or scraper run's results by its run id (from an error message, list_runs, or the user): it follows the run if it is still going, then returns its report, and a scraper's CSVs become datasets in the workspace, described like a normal return (files already imported are not imported twice). Use it instead of sending the run again when its results didn't arrive (a failed hand-off): a new run costs money and may duplicate the work.",
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'The run (session) id, e.g. sesn_….' } }, required: ['runId'] },
  },
  {
    name: 'read_run',
    description:
      "Look inside a scout or scraper run by its run id, changing nothing: its status now (still running, finished, stopped), how it stopped, its cost, what it did step by step (pages fetched, commands, its messages, errors), its last message and the files it made. Free; nothing is imported. Use it to see where a run got to and why it failed before deciding what to do (fetch_run to collect its results, or a new brief that fixes what went wrong).",
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'The run (session) id, e.g. sesn_….' } }, required: ['runId'] },
  },
]

/** Output files that become datasets: tables, and shapes. */
export const IMPORTABLE = /\.(csv|geojson)$/i

/** A scraped file's description until the assistant writes one: when and what was asked for (the brief, trimmed). */
export function webFileDescription(day: string, sessionId: string, brief: string): string {
  const asked = brief.trim().replace(/\s+/g, ' ')
  return `From the web, ${day} (scraper run ${sessionId}), ${PLACEHOLDER}.\nAsked for: ${asked.length > 400 ? `${asked.slice(0, 400)}…` : asked}`
}

export const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)

export const clampCap = (n: number) => Math.round(Math.min(CAP_RANGE.max, Math.max(CAP_RANGE.min, n)) * 100) / 100

/** The assistant's recommended cap (any amount in range), else the role's default. */
export const recommendedCap = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? clampCap(n) : fallback)

/** A cap the user picked or typed ("Recommended: $1.50", "$3", "3", "2.5 dollars"), or undefined. */
export function readCap(v: unknown): number | undefined {
  const t = Array.isArray(v) ? v[v.length - 1] : v
  const m = typeof t === 'string' ? t.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/) : null
  return m ? clampCap(Number(m[1])) : undefined
}

/** The brief with its needs written out, one per line, for the scout to work through. */
export function briefWithNeeds(brief: string, needs: unknown): string {
  const list = (Array.isArray(needs) ? needs : []).filter((n): n is Obj => isObj(n) && str(n.need) && !!n.need.trim())
  if (!list.length) return brief.trim()
  const line = (n: Obj) => `- ${String(n.need).trim()}${str(n.measure) && n.measure.trim() ? ` — ${n.measure.trim()}` : ''}${str(n.where) && n.where.trim() ? `; ${n.where.trim()}` : ''}${str(n.posture) ? ` (${n.posture})` : ''}`
  return `${brief.trim()}\n\nNeeds:\n${list.map(line).join('\n')}`
}

export async function sendWeb(host: AgentHost, role: WebRole, input: Obj): Promise<ToolOutcome> {
  need(str(input.brief) && input.brief.trim(), '`brief` is required')
  const given = role === 'scout' ? briefWithNeeds(input.brief, input.needs) : input.brief.trim()
  if (!host.web) return err('Sending the scout or scraper isn\'t available here.')
  // Before the approval card: asking to approve a run that then can't start wastes the user's time.
  if (host.signedIn && !host.signedIn()) {
    host.askSignIn?.()
    return err('The scout and scraper need the user signed in to PowerGIS (☰ → Sign in; a Sign in button is now in the chat); the chat itself works without. Nothing was sent. Tell the user, and carry on with what the workspace has, or wait for them to sign in and ask again.')
  }
  const cap = recommendedCap(input.cap_dollars, role === 'scout' ? 1 : 2)
  const why = str(input.cap_reason) && input.cap_reason.trim() ? input.cap_reason.trim() : ''
  const recommended = `Recommended: ${money(cap)}`
  const Role = role === 'scout' ? 'scout' : 'scraper'
  const card = runCard({ role, brief: given, caps: WEB_CAPS.filter((c) => c !== cap).map(money), recommended, ...(why ? { capWhy: `How it was sized: ${why}.` } : {}) })
  const a = await host.ask(card)
  const out = runOutcome(card, a, (v) => readCap(v))
  const notes = out.comments.length ? { comments: out.comments } : {}
  if (out.decision !== 'approved') return ok({ sent: false, decision: out.decision, ...notes, next: out.next }, 'not sent')
  const brief = out.value!.brief
  const capDollars = out.value!.cap ?? cap
  const run = await host.web(role, brief, capDollars)
  if (typeof run === 'string') return err(run, `${Role} not sent`)
  const edited = brief !== given ? { briefEditedByUser: brief } : {}
  const facts = { stop: run.stop, cost: run.cost, elapsedSeconds: run.elapsedSeconds, ...(run.missing?.length ? { filesThatNeverCameBack: run.missing } : {}), ...edited, ...notes }
  const head = `${run.stop === 'end_turn' ? 'finished' : run.stop} · ${Math.round(run.elapsedSeconds)} s${run.cost !== undefined ? ` · $${run.cost.toFixed(2)}` : ''}`
  if (role === 'scout') {
    const parsed = parseScoutReport(run.report)
    const found = parsed.needs?.reduce((n, x) => n + x.sources.length, 0) ?? 0
    return ok({ report: parsed.text, ...(parsed.needs ? { sources: parsed.needs } : {}), ...facts }, `${head}${found ? ` · ${plural(found, 'source')}` : ''}`)
  }
  const files = await importRunFiles(host, run, brief, new Date())
  const imported = files.filter((f) => 'datasetId' in f).length
  return ok({ summary: run.report, files, ...facts }, `${head} · ${plural(imported, 'dataset')} added`)
}

/** A scraper run's CSVs / GeoJSON as datasets (described with the run and its brief); the rest (its script) stays with the run. */
export async function importRunFiles(host: AgentHost, run: WebRun, brief: string, when: Date) {
  const day = when.toISOString().slice(0, 10)
  const files = []
  for (const f of run.files) {
    if (!IMPORTABLE.test(f.name) || !host.importWebFile) {
      files.push({ name: f.name, bytes: f.bytes })
      continue
    }
    const r = await host.importWebFile(f.id, f.name, webFileDescription(day, run.sessionId, brief))
    if (r.ok) made(host).add(r.id)
    files.push(r.ok ? { name: f.name, datasetId: r.id } : { name: f.name, importError: r.message })
  }
  return files
}

export function listRuns(host: AgentHost): ToolOutcome {
  const runs = host.runs?.() ?? []
  if (!runs.length) return ok({ runs: [] }, 'no runs on this device')
  return ok(
    {
      runs: runs.map((x) => ({
        runId: x.sessionId,
        role: x.role,
        brief: x.brief.length > 200 ? `${x.brief.slice(0, 200)}…` : x.brief,
        started: new Date(x.startedAt).toISOString(),
        state: x.state,
        ...(x.error ? { error: x.error } : {}),
        ...(x.cost !== undefined ? { cost: x.cost } : {}),
        ...(x.files?.length ? { files: x.files } : {}),
      })),
    },
    plural(runs.length, 'run'),
  )
}

export async function fetchRun(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.runId) && input.runId.trim(), '`runId` is required')
  if (!host.fetchRun) return err('Fetching a run isn\'t available here.')
  const run = await host.fetchRun(input.runId.trim())
  if (typeof run === 'string') return err(run, 'not fetched')
  const head = `${run.stop === 'end_turn' ? 'finished' : run.stop}${run.cost !== undefined ? ` · $${run.cost.toFixed(2)}` : ''}`
  const facts = { runId: run.sessionId, role: run.role, stop: run.stop, cost: run.cost, ...(run.missing?.length ? { filesThatNeverCameBack: run.missing } : {}) }
  if (run.role === 'scout') return ok({ report: run.report, ...facts }, head)
  const files = await importRunFiles(host, run, run.brief, new Date())
  return ok({ summary: run.report, files, ...facts }, `${head} · ${plural(files.filter((f) => 'datasetId' in f).length, 'dataset')}`)
}

export async function readRun(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.runId) && input.runId.trim(), '`runId` is required')
  if (!host.readRun) return err('Reading a run isn\'t available here.')
  const r = await host.readRun(input.runId.trim())
  if (typeof r === 'string') return err(r, 'not read')
  return ok({ trace: r.text }, `${r.status} · ${plural(r.files.length, 'file')}`)
}

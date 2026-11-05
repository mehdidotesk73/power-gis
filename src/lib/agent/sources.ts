// What the scout found, in a shape the app can use (docs/TODO.md, item 2, PR B).
//
// The scout ends its report with one line, `SOURCES: {json}`: per need, the
// candidate sources — what each measures exactly (units, money basis, mean or
// median, period), at which unit and coverage, how to get it, terms, and how
// confident it is — and, when several answer a need together, how they could be
// combined. parseScoutReport splits that line from the prose. The sources go into
// a ledger kept on this device, so later chats check what was already found
// (list_sources) before sending the scout again; only an exact match skips it.
// Pure: the page stores the ledger (AgentPanel, `powergis.sources`).

export type Confidence = 'high' | 'medium' | 'low'

export interface FoundSource {
  name: string
  url: string
  /** Exactly what it measures: units, money basis, mean or median, per year or month. */
  measures: string
  /** The unit of analysis (countries, counties, grid cells…) and which places. */
  coverage: string
  period?: string
  /** How to get it: a download link, an API, a page to scrape — and the layout seen. */
  access?: string
  terms?: string
  confidence?: Confidence
}

export interface FoundNeed {
  need: string
  sources: FoundSource[]
  /** When several sources answer it together: what anchors, what fills in, how they're calibrated. */
  combination?: string
  /** Shapes for the unit, when they're data to find too. */
  boundaries?: string
}

export interface ScoutReport {
  /** The report without its SOURCES line. */
  text: string
  /** The structured list, when the scout gave a readable one. */
  needs?: FoundNeed[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function readSource(v: unknown): FoundSource | null {
  if (!isObj(v)) return null
  const name = str(v.name)
  const url = str(v.url)
  if (!name || !url) return null
  const confidence = v.confidence === 'high' || v.confidence === 'medium' || v.confidence === 'low' ? v.confidence : undefined
  return {
    name,
    url,
    measures: str(v.measures) ?? '',
    coverage: str(v.coverage) ?? '',
    ...(str(v.period) ? { period: str(v.period) } : {}),
    ...(str(v.access) ? { access: str(v.access) } : {}),
    ...(str(v.terms) ? { terms: str(v.terms) } : {}),
    ...(confidence ? { confidence } : {}),
  }
}

/** The report's prose and its SOURCES list (anything malformed in the list is skipped, never fatal). */
export function parseScoutReport(report: string): ScoutReport {
  const lines = report.split('\n')
  const at = lines.findIndex((l) => /^\s*SOURCES:\s*\{/.test(l))
  if (at < 0) return { text: report.trim() }
  // The JSON may run over several lines: take from the marker to the end and back off to the last closing brace.
  const tail = lines.slice(at).join('\n').replace(/^\s*SOURCES:\s*/, '')
  const end = tail.lastIndexOf('}')
  const text = lines.slice(0, at).join('\n').trim()
  try {
    const parsed = JSON.parse(tail.slice(0, end + 1)) as unknown
    const list = isObj(parsed) && Array.isArray(parsed.needs) ? parsed.needs : []
    const needs = list.flatMap((n): FoundNeed[] => {
      if (!isObj(n) || !str(n.need)) return []
      const sources = (Array.isArray(n.sources) ? n.sources : []).map(readSource).filter((s): s is FoundSource => !!s)
      return [{ need: str(n.need)!, sources, ...(str(n.combination) ? { combination: str(n.combination) } : {}), ...(str(n.boundaries) ? { boundaries: str(n.boundaries) } : {}) }]
    })
    return needs.length ? { text, needs } : { text }
  } catch {
    return { text }
  }
}

// ── the ledger: sources found earlier, on this device ──────────────────────

export interface LedgerEntry extends FoundSource {
  /** The need it was found for. */
  need: string
  /** The scout run that found it, and when (YYYY-MM-DD). */
  runId: string
  found: string
}

/** Most recent first, at most this many. */
export const LEDGER_SIZE = 200

/** The ledger with a run's sources added: one entry per URL and need, the newest finding kept. */
export function addToLedger(ledger: LedgerEntry[], needs: FoundNeed[], runId: string, found: string): LedgerEntry[] {
  const fresh = needs.flatMap((n) => n.sources.map((s) => ({ ...s, need: n.need, runId, found })))
  const key = (e: LedgerEntry) => `${e.url}|${e.need.toLowerCase()}`
  const seen = new Set(fresh.map(key))
  return [...fresh, ...ledger.filter((e) => !seen.has(key(e)))].slice(0, LEDGER_SIZE)
}

const words = (t: string) => t.toLowerCase().match(/[a-z0-9]+/g) ?? []

/** Entries whose need, name or measure share words with the query, best match first. */
export function searchLedger(ledger: LedgerEntry[], query: string, limit = 12): LedgerEntry[] {
  const q = new Set(words(query).filter((w) => w.length > 2))
  if (!q.size) return ledger.slice(0, limit)
  return ledger
    .map((e) => ({ e, score: words(`${e.need} ${e.name} ${e.measures} ${e.coverage}`).filter((w) => q.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e)
}

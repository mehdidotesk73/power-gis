// What the scout found, in a shape the app can use (docs/TODO.md, item 2, PR B).
//
// The scout ends its report with one line, `SOURCES: {json}`: per need, the
// candidate sources — what each measures exactly (units, money basis, mean or
// median, period), at which unit and coverage, how to get it, terms, and how
// confident it is — and, when several answer a need together, how they could be
// combined. parseScoutReport splits that line from the prose; the assistant gets
// both. (What's already on the device or in the account is checked before any
// scouting with list_datasets: descriptions, metadata, a sample query.) Pure.

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

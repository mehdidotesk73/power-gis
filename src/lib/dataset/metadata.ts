// A dataset's structured metadata (shared/records.ts DatasetMetadata): reading
// it from anywhere (files, the cloud, the agent), comparing, and writing it out
// as text for people and the storyteller. The plain-language description and
// free notes sit beside it on the record; "Made by" and "Feeds" come from the
// workspace graph.

import type { DatasetEstimate, DatasetMetadata, DatasetSource } from '../../shared/records'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export const SOURCE_KEYS = ['publisher', 'publisherAbout', 'title', 'urls', 'coverage', 'period', 'fetched', 'method', 'terms'] as const
export const METADATA_KEYS = ['row', 'key', 'columns', 'source', 'caveats', 'estimate'] as const
export const ESTIMATE_KEYS = ['method', 'value', 'range', 'assumptions', 'fit'] as const
export const ESTIMATE_METHODS = ['fill', 'scale', 'deduce'] as const
const COLUMN_KEYS = ['name', 'meaning', 'unit']

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const texts = (v: unknown) => (Array.isArray(v) ? v.flatMap((x) => (text(x) ? [text(x)!] : [])) : [])

/**
 * Metadata from untrusted JSON, with what's wrong listed (unknown keys, wrong types). Empty parts are
 * dropped; nothing at all reads as undefined.
 */
export function readMetadata(v: unknown, where = 'metadata'): { value: DatasetMetadata | undefined; errors: string[] } {
  const errors: string[] = []
  if (v === undefined || v === null) return { value: undefined, errors }
  if (!isObj(v)) return { value: undefined, errors: [`${where} must be an object (${METADATA_KEYS.join(', ')})`] }
  for (const k of Object.keys(v)) if (!(METADATA_KEYS as readonly string[]).includes(k)) errors.push(`${where}: unknown field "${k}" (fields: ${METADATA_KEYS.join(', ')})`)
  const str = (k: string, o: Obj, w: string) => {
    if (o[k] !== undefined && typeof o[k] !== 'string') errors.push(`${w}.${k} must be text`)
    return text(o[k])
  }
  const list = (k: string, o: Obj, w: string) => {
    if (o[k] !== undefined && !(Array.isArray(o[k]) && (o[k] as unknown[]).every((x) => typeof x === 'string'))) errors.push(`${w}.${k} must be a list of text`)
    return texts(o[k])
  }
  const m: DatasetMetadata = {}
  const row = str('row', v, where)
  const key = str('key', v, where)
  if (row) m.row = row
  if (key) m.key = key
  if (v.columns !== undefined) {
    if (!Array.isArray(v.columns)) errors.push(`${where}.columns must be a list of {name, meaning, unit}`)
    else {
      const cols = v.columns.flatMap((c, i) => {
        const w = `${where}.columns[${i}]`
        if (!isObj(c) || !text(c.name)) return errors.push(`${w} needs a "name"`), []
        for (const k of Object.keys(c)) if (!COLUMN_KEYS.includes(k)) errors.push(`${w}: unknown field "${k}" (fields: ${COLUMN_KEYS.join(', ')})`)
        const meaning = str('meaning', c, w)
        const unit = str('unit', c, w)
        return [{ name: text(c.name)!, ...(meaning ? { meaning } : {}), ...(unit ? { unit } : {}) }]
      })
      if (cols.length) m.columns = cols
    }
  }
  if (v.source !== undefined) {
    if (!isObj(v.source)) errors.push(`${where}.source must be an object (${SOURCE_KEYS.join(', ')})`)
    else {
      const o = v.source
      for (const k of Object.keys(o)) if (!(SOURCE_KEYS as readonly string[]).includes(k)) errors.push(`${where}.source: unknown field "${k}" (fields: ${SOURCE_KEYS.join(', ')})`)
      const s: DatasetSource = {}
      for (const k of SOURCE_KEYS) {
        if (k === 'urls') {
          const urls = list('urls', o, `${where}.source`)
          if (urls.length) s.urls = urls
        } else {
          const t = str(k, o, `${where}.source`)
          if (t) s[k] = t
        }
      }
      if (Object.keys(s).length) m.source = s
    }
  }
  const caveats = list('caveats', v, where)
  if (caveats.length) m.caveats = caveats
  if (v.estimate !== undefined) {
    const w = `${where}.estimate`
    const o = v.estimate
    if (!isObj(o)) errors.push(`${w} must be an object (${ESTIMATE_KEYS.join(', ')})`)
    else {
      for (const k of Object.keys(o)) if (!(ESTIMATE_KEYS as readonly string[]).includes(k)) errors.push(`${w}: unknown field "${k}" (fields: ${ESTIMATE_KEYS.join(', ')})`)
      if (!(ESTIMATE_METHODS as readonly unknown[]).includes(o.method)) errors.push(`${w}.method must be one of ${ESTIMATE_METHODS.join(', ')}`)
      else {
        const e: DatasetEstimate = { method: o.method as DatasetEstimate['method'] }
        const value = str('value', o, w)
        if (value) e.value = value
        if (o.range !== undefined) {
          const r = o.range
          if (!isObj(r) || !['low', 'likely', 'high'].every((k) => text(r[k]))) errors.push(`${w}.range must name its columns: {low, likely, high}`)
          else e.range = { low: text(r.low)!, likely: text(r.likely)!, high: text(r.high)! }
        }
        const assumptions = list('assumptions', o, w)
        if (assumptions.length) e.assumptions = assumptions
        const fit = str('fit', o, w)
        if (fit) e.fit = fit
        m.estimate = e
      }
    }
  }
  return { value: Object.keys(m).length ? m : undefined, errors }
}

/** Metadata from a trusted place (records, documents, the cloud): what's readable kept, the rest dropped. */
export const cleanMetadata = (v: unknown): DatasetMetadata | undefined => readMetadata(v).value

/** Equal metadata (key order and empty parts aside). */
export const sameMetadata = (a: DatasetMetadata | undefined, b: DatasetMetadata | undefined) => JSON.stringify(cleanMetadata(a) ?? null) === JSON.stringify(cleanMetadata(b) ?? null)

/** The source in a sentence: "CDC (the federal public-health agency): PLACES 2025 release". */
export function sourceLine(s: DatasetSource | undefined): string | undefined {
  if (!s) return undefined
  const who = s.publisher ? `${s.publisher}${s.publisherAbout ? ` (${s.publisherAbout})` : ''}` : undefined
  const what = [s.title, s.period].filter(Boolean).join(', ')
  return [who, what].filter(Boolean).join(': ') || undefined
}

const ESTIMATE_WORDS: Record<DatasetEstimate['method'], string> = {
  fill: 'gaps filled from what it correlates with',
  scale: 'carried from larger areas through a proxy',
  deduce: 'deduced step by step from first principles',
}

/** Metadata as labelled lines (cards, the storyteller, overviews). */
export function metadataLines(m: DatasetMetadata | undefined): string[] {
  if (!m) return []
  const out: string[] = []
  if (m.row) out.push(`Row: ${m.row}${m.key ? ` · key ${m.key}` : ''}`)
  else if (m.key) out.push(`Key: ${m.key}`)
  if (m.columns?.length) out.push(`Columns: ${m.columns.map((c) => `${c.name}${c.meaning || c.unit ? ` (${[c.meaning, c.unit].filter(Boolean).join(', ')})` : ''}`).join('; ')}`)
  const s = m.source
  if (s) {
    const line = sourceLine(s)
    if (line) out.push(`Source: ${line}`)
    if (s.coverage) out.push(`Covers: ${s.coverage}`)
    if (s.method) out.push(`How it was made: ${s.method}`)
    if (s.fetched) out.push(`Fetched: ${s.fetched}`)
    if (s.terms) out.push(`Terms: ${s.terms}`)
    if (s.urls?.length) out.push(`URLs: ${s.urls.join(' ')}`)
  }
  if (m.caveats?.length) out.push(`Caveats: ${m.caveats.join(' · ')}`)
  const e = m.estimate
  if (e) {
    out.push(`Estimated (${ESTIMATE_WORDS[e.method]})${e.value ? `: ${e.value}` : ''}${e.range ? `, range ${e.range.low} – ${e.range.high}` : ''}`)
    if (e.assumptions?.length) out.push(`Assumptions: ${e.assumptions.join(' · ')}`)
    if (e.fit) out.push(`Fit: ${e.fit}`)
  }
  return out
}

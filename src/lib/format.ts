import { parseVector, type FieldType } from './schema'

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const dblFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** One primitive value as display text. */
export function formatPrimitive(v: unknown, t: FieldType, unit?: string): string {
  if (v === null || v === undefined || v === '') return '—'
  let s: string
  switch (t) {
    case 'int':
      s = intFmt.format(Number(v))
      break
    case 'double':
      s = dblFmt.format(Number(v))
      break
    case 'boolean':
      s = v ? 'Yes' : 'No'
      break
    case 'vector': {
      const vec = parseVector(v)
      if (!vec) return String(v)
      const deg = Math.round(((Math.atan2(vec.u, vec.v) * 180) / Math.PI + 360) % 360)
      s = `${dblFmt.format(Math.hypot(vec.u, vec.v))} toward ${deg}°`
      break
    }
    case 'datetime': {
      const d = new Date(String(v))
      s = Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString()
      break
    }
    default:
      s = String(v)
  }
  return unit ? `${s} ${unit}` : s
}

export function formatCompact(n: number): string {
  return Math.abs(n) >= 10000 ? compactFmt.format(n) : dblFmt.format(n)
}

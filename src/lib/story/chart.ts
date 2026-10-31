// Charts for stories: a query's result → what a chart draws (kept as the
// figure's snapshot), and that → shapes for an SVG. Five kinds: bar, pie,
// line, scatter, histogram. No chart library: a few rectangles, arcs, a path
// and dots, in the app's palette.

import type { ChartKind, Snapshot } from './story'

/** Rows a chart may draw: more is a sign the SQL should aggregate. */
export const CHART_LIMITS: Record<ChartKind, number> = { bar: 30, pie: 12, line: 400, scatter: 3000, histogram: 20000 }
/** Points a scatter keeps in its snapshot (evenly picked), and a histogram's bins. */
export const SCATTER_KEEP = 300
export const BINS = 12

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'bigint' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * What a chart draws from a query's rows, as a small table: bar / pie / line: [x, y] per row;
 * scatter: [x, y] (at most SCATTER_KEEP points); histogram: [from, to, count] per bin of x.
 * A message when the rows don't fit the chart.
 */
export function chartData(kind: ChartKind, x: string, y: string | undefined, columns: string[], rows: Record<string, unknown>[]): Snapshot | string {
  if (!columns.includes(x)) return `"${x}" isn't a column of the result (${columns.join(', ')})`
  if (kind !== 'histogram' && (!y || !columns.includes(y))) return `"${y ?? ''}" isn't a column of the result (${columns.join(', ')})`
  if (rows.length > CHART_LIMITS[kind]) return `${rows.length} rows is too many for a ${kind} chart (at most ${CHART_LIMITS[kind]}): aggregate in the SQL, or LIMIT it`
  if (kind === 'histogram') {
    const vals = rows.map((r) => num(r[x])).filter((n): n is number => n !== null)
    if (!vals.length) return `"${x}" has no numbers to count`
    let lo = Math.min(...vals)
    let hi = Math.max(...vals)
    if (lo === hi) [lo, hi] = [lo - 0.5, hi + 0.5]
    const w = (hi - lo) / BINS
    const counts = new Array(BINS).fill(0)
    for (const v of vals) counts[Math.min(BINS - 1, Math.floor((v - lo) / w))]++
    return { columns: ['from', 'to', 'count'], rows: counts.map((c, i) => [round(lo + i * w), round(lo + (i + 1) * w), c]) }
  }
  const pairs = rows.map((r) => [kind === 'bar' || kind === 'pie' ? String(r[x] ?? '—') : num(r[x]) ?? String(r[x] ?? ''), num(r[y!])])
  if (pairs.every((p) => p[1] === null)) return `"${y}" has no numbers to draw`
  if (kind === 'pie' && pairs.some((p) => (p[1] as number) < 0)) return `a pie can't show negative values ("${y}")`
  const kept = kind === 'scatter' && pairs.length > SCATTER_KEEP ? Array.from({ length: SCATTER_KEEP }, (_, i) => pairs[Math.floor((i * pairs.length) / SCATTER_KEEP)]) : pairs
  return { columns: [x, y!], rows: kept }
}

const round = (n: number) => Number(n.toPrecision(4))

/** Short numbers for axes and labels: 1.2K, 3.4M, 0.25. */
export function short(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${round(n / 1e9)}B`
  if (a >= 1e6) return `${round(n / 1e6)}M`
  if (a >= 1e4) return `${round(n / 1e3)}K`
  return String(round(n))
}

/** About `count` round ticks across [lo, hi]. */
export function ticks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo]
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(round(t))
  return out
}

export interface ChartShapes {
  width: number
  height: number
  /** Plot area. */
  plot: { x: number; y: number; w: number; h: number }
  bars: { x: number; y: number; w: number; h: number; label: string; value: number }[]
  slices: { path: string; label: string; value: number; share: number; color: number }[]
  line?: string
  dots: { x: number; y: number }[]
  xTicks: { at: number; label: string }[]
  yTicks: { at: number; label: string }[]
}

const W = 360
const H = 220
const PAD = { left: 40, right: 10, top: 10, bottom: 34 }

/** Where everything goes in a W × H chart (the component draws them with the page's colours). */
export function chartShapes(kind: ChartKind, data: Snapshot): ChartShapes {
  const plot = { x: PAD.left, y: PAD.top, w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom }
  const base: ChartShapes = { width: W, height: H, plot, bars: [], slices: [], dots: [], xTicks: [], yTicks: [] }
  const ys = (lo: number, hi: number) => (v: number) => plot.y + plot.h - ((v - lo) / (hi - lo || 1)) * plot.h
  const xs = (lo: number, hi: number) => (v: number) => plot.x + ((v - lo) / (hi - lo || 1)) * plot.w

  if (kind === 'pie') {
    const rows = data.rows.map((r) => ({ label: String(r[0]), value: num(r[1]) ?? 0 })).filter((r) => r.value > 0)
    const total = rows.reduce((s, r) => s + r.value, 0) || 1
    const cx = W / 2
    const cy = H / 2
    const rad = Math.min(W, H) / 2 - 12
    let a = -Math.PI / 2
    base.slices = rows.map((r, i) => {
      const share = r.value / total
      const b = a + share * 2 * Math.PI
      const large = share > 0.5 ? 1 : 0
      const p = (t: number) => `${(cx + rad * Math.cos(t)).toFixed(1)} ${(cy + rad * Math.sin(t)).toFixed(1)}`
      const path = share >= 0.9999 ? `M ${cx - rad} ${cy} a ${rad} ${rad} 0 1 0 ${2 * rad} 0 a ${rad} ${rad} 0 1 0 ${-2 * rad} 0` : `M ${cx} ${cy} L ${p(a)} A ${rad} ${rad} 0 ${large} 1 ${p(b)} Z`
      a = b
      return { path, label: r.label, value: r.value, share, color: i }
    })
    return base
  }

  if (kind === 'bar' || kind === 'histogram') {
    const bars = kind === 'bar' ? data.rows.map((r) => ({ label: String(r[0]), value: num(r[1]) ?? 0 })) : data.rows.map((r) => ({ label: short(num(r[0]) ?? 0), value: num(r[2]) ?? 0 }))
    const lo = Math.min(0, ...bars.map((b) => b.value))
    const hi = Math.max(0, ...bars.map((b) => b.value))
    const y = ys(lo, hi)
    const slot = plot.w / Math.max(1, bars.length)
    const gap = kind === 'histogram' ? 1 : Math.min(8, slot * 0.2)
    base.bars = bars.map((b, i) => ({ x: plot.x + i * slot + gap / 2, y: Math.min(y(b.value), y(0)), w: Math.max(1, slot - gap), h: Math.abs(y(b.value) - y(0)), label: b.label, value: b.value }))
    base.yTicks = ticks(lo, hi).map((t) => ({ at: y(t), label: short(t) }))
    const every = Math.ceil(bars.length / 8)
    base.xTicks = bars.flatMap((b, i) => (i % every === 0 ? [{ at: plot.x + (i + 0.5) * slot, label: b.label.length > 10 ? `${b.label.slice(0, 9)}…` : b.label }] : []))
    if (kind === 'histogram' && data.rows.length) base.xTicks = [...base.xTicks.filter((_, i) => i % 2 === 0)]
    return base
  }

  // line / scatter: numbers on both axes
  const pts = data.rows.map((r) => [num(r[0]), num(r[1])]).filter((p): p is [number, number] => p[0] !== null && p[1] !== null)
  if (!pts.length) return base
  const [xlo, xhi] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))]
  const [ylo, yhi] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))]
  const x = xs(xlo, xhi)
  const y = ys(ylo, yhi)
  if (kind === 'line') {
    const sorted = [...pts].sort((a, b) => a[0] - b[0])
    base.line = sorted.map((p, i) => `${i ? 'L' : 'M'} ${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ')
    if (sorted.length <= 40) base.dots = sorted.map((p) => ({ x: x(p[0]), y: y(p[1]) }))
  } else base.dots = pts.map((p) => ({ x: x(p[0]), y: y(p[1]) }))
  base.xTicks = ticks(xlo, xhi).map((t) => ({ at: x(t), label: short(t) }))
  base.yTicks = ticks(ylo, yhi).map((t) => ({ at: y(t), label: short(t) }))
  return base
}

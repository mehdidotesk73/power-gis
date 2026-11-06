// Estimation pieces (pure; the assistant's recipe tool): small SQL building
// blocks that compose, each one a transform output (or, for correlate, a
// query), about any places and any measure. Complexity comes from chaining
// them, not from any one piece:
//
// - composite: several measures combined into one index (each turned into a
//   percentile with its direction, then a weighted mean): "tech-savvy" from
//   education, tech jobs and tech exports.
// - adjust: a measure scaled by a broader property of each place, a class
//   (urban / rural, elevation band) with a factor each, or an index with a
//   strength: population adjusted for tech-savviness.
// - correlate: how well one measure tracks another, at the same unit (r², the
//   line, how many places): a query to compare candidate sides before using one.
// - fill (breadth): a measure's gaps filled from what it correlates with, at
//   the same unit: Netflix revenue for the states that don't report it.
// - scale (depth): a measure carried from coarse units to the finer ones inside
//   them through a proxy: shared out where the coarse total is known, from the
//   fitted line where it isn't.
// - deduce (Fermi): a chain of steps from what's known to the unknown, each
//   low / likely / high, written as plain arithmetic (+ − × ÷, min, max for
//   physical limits) over numbers, the table's columns and earlier steps;
//   optionally two chains meeting at the same unknown from both sides.
//
// The pieces take table and column names (input aliases), never SQL text;
// deduce's arithmetic is parsed and rebuilt. Each answer has the SQL, its
// columns and, for estimates (fill, scale, deduce), what the output's metadata
// should record (shared/records.ts DatasetEstimate) and its caveats. They are
// supplements, not the only way: the assistant writes its own SQL whenever that
// fits better.

import type { DatasetEstimate } from '../../shared/records'

export const RECIPE_KINDS = ['composite', 'adjust', 'correlate', 'fill', 'scale', 'deduce'] as const
export type RecipeKind = (typeof RECIPE_KINDS)[number]

export interface Composite {
  kind: 'composite'
  table: string
  unit: string
  /** The measures combined: each a column, its weight (default 1) and which way is "more" (default up). */
  parts: { column: string; weight?: number; direction?: 'up' | 'down' }[]
  as?: string
}
export interface Adjust {
  kind: 'adjust'
  table: string
  unit: string
  measure: string
  /** The property it's adjusted by: a class column (with factors) or an index column (with strength). */
  by: string
  /** A class's multiplier ({"urban": 1.2, "rural": 0.9}); classes not listed keep 1. */
  factors?: Record<string, number>
  /** For an index: measure × (1 + strength × (index − its mean)). */
  strength?: number
  as?: string
}
export interface Correlate {
  kind: 'correlate'
  table: string
  /** The two sides: x tracks y? */
  x: string
  y: string
  /** One line per class (urban / rural…) instead of one overall. */
  group?: string
}
export interface Fill {
  kind: 'fill'
  table: string
  unit: string
  /** What it correlates with (known everywhere it's needed). */
  x: string
  /** The measure with gaps. */
  y: string
  as?: string
}
export interface Scale {
  kind: 'scale'
  /** The fine table, one row per finer unit. */
  fine: string
  unit: string
  /** The fine column naming the coarse unit each is in. */
  parent: string
  /** The finer units' proxy (any scale: shares and the fit set it). */
  proxy: string
  /** The coarse table, one row per coarse unit, with its total. */
  coarse: string
  coarseParent?: string
  total: string
  as?: string
}
/** A deduction step: an expression over earlier steps, columns and numbers; or an assumption given as low / likely / high. */
export interface Step {
  name: string
  expr?: string
  low?: number | string
  likely?: number | string
  high?: number | string
}
export interface Deduce {
  kind: 'deduce'
  /** The table whose rows are the units deduced for. */
  base: string
  unit: string
  steps: Step[]
  /** Two steps that estimate the same unknown from two sides: their overlap and how well they agree. */
  meet?: { a: string; b: string; as?: string }
}

export type Recipe = Composite | Adjust | Correlate | Fill | Scale | Deduce

export interface RecipeSql {
  sql: string
  columns: string[]
  /** For estimates: what the output's metadata.estimate starts from (the assistant adds assumptions and the fit it reads). */
  estimate?: DatasetEstimate
  caveats: string[]
}

// ── names and numbers ──────────────────────────────────────────────────────

const NAME = /^[A-Za-z_][A-Za-z0-9_ ]{0,62}$/
/** A table or column name, quoted for SQL; anything else is refused (recipes never take SQL text). */
export function ident(name: unknown, what: string): string {
  if (typeof name !== 'string' || !NAME.test(name.trim())) throw new Error(`${what} must be a table or column name (letters, digits, _), got ${JSON.stringify(name)}`)
  return `"${name.trim()}"`
}
const plain = (v: unknown) => String(v).trim()
const outName = (v: unknown, fallback: string, what: string) => (v === undefined || v === '' ? fallback : (ident(v, what), plain(v)))
function num(v: unknown, what: string): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} must be a number`)
  return `CAST(${v} AS DOUBLE)`
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
const dbl = (q: string) => `CAST(${q} AS DOUBLE)`

// ── composite ─────────────────────────────────────────────────────────────

export function compositeSql(r: Composite): RecipeSql {
  const table = ident(r.table, 'table')
  const unit = ident(r.unit, 'unit')
  if (!Array.isArray(r.parts) || !r.parts.length) throw new Error('A composite needs at least one part')
  const as = outName(r.as, 'index', 'as')
  const parts = r.parts.map((p, i) => {
    const col = ident(p?.column, `parts[${i}].column`)
    const w = p.weight === undefined ? 1 : (num(p.weight, `parts[${i}].weight`), p.weight)
    const down = p.direction === 'down'
    if (p.direction !== undefined && p.direction !== 'up' && !down) throw new Error(`parts[${i}].direction must be "up" or "down"`)
    const pct = `${plain(p.column)}_pct`
    // A percentile among the places that have the measure (0 = lowest, 1 = highest; flipped when lower is "more").
    const rank = `CASE WHEN t.${col} IS NULL THEN NULL ELSE ${down ? '1 - ' : ''}percent_rank() OVER (PARTITION BY t.${col} IS NULL ORDER BY ${dbl(`t.${col}`)}) END`
    return { pct, rank, w }
  })
  const num_ = parts.map((p) => `coalesce(${p.w} * "${p.pct}", 0)`).join(' + ')
  const den = parts.map((p) => `CASE WHEN "${p.pct}" IS NULL THEN 0 ELSE ${p.w} END`).join(' + ')
  const sql = `-- Composite: ${r.parts.map((p) => `${p.column}${p.direction === 'down' ? ' (lower is more)' : ''}${p.weight !== undefined ? ` ×${p.weight}` : ''}`).join(', ')}, each as a percentile, then a weighted mean (0 to 1).
WITH p AS (SELECT t.${unit} AS ${unit}, ${parts.map((p) => `${p.rank} AS "${p.pct}"`).join(', ')} FROM ${table} AS t)
SELECT *, (${num_}) / nullif(${den}, 0) AS "${as}" FROM p`
  return {
    sql,
    columns: [plain(r.unit), ...parts.map((p) => p.pct), as],
    caveats: [`${as} is relative, not absolute: each part is a percentile among these places, so it ranks places against each other (0 = lowest, 1 = highest) and a place's value changes when the set of places does.`],
  }
}

// ── adjust ────────────────────────────────────────────────────────────────

export function adjustSql(r: Adjust): RecipeSql {
  const [table, unit, measure, by] = [ident(r.table, 'table'), ident(r.unit, 'unit'), ident(r.measure, 'measure'), ident(r.by, 'by')]
  const as = outName(r.as, `adjusted_${plain(r.measure)}`.slice(0, 63), 'as')
  let multiplier: string
  let how: string
  if (r.factors !== undefined) {
    if (typeof r.factors !== 'object' || r.factors === null || Array.isArray(r.factors) || !Object.keys(r.factors).length) throw new Error('factors must map each class to a number, e.g. {"urban": 1.2, "rural": 0.9}')
    const cases = Object.entries(r.factors).map(([k, v]) => `WHEN ${lit(k)} THEN ${num(v, `factors.${k}`)}`)
    multiplier = `CASE CAST(t.${by} AS VARCHAR) ${cases.join(' ')} ELSE 1 END`
    how = `by class (${Object.entries(r.factors).map(([k, v]) => `${k} ×${v}`).join(', ')}; others ×1)`
  } else if (r.strength !== undefined) {
    multiplier = `1 + ${num(r.strength, 'strength')} * (${dbl(`t.${by}`)} - avg(${dbl(`t.${by}`)}) OVER ())`
    how = `by index (× 1 + ${r.strength} × how far ${r.by} is from its mean)`
  } else throw new Error('adjust needs factors (for a class column) or strength (for an index column)')
  const sql = `-- Adjust: ${r.measure} ${how}, ${r.by}.
SELECT t.${unit} AS ${unit}, t.${measure} AS ${measure}, t.${by} AS ${by}, ${multiplier} AS multiplier, ${dbl(`t.${measure}`)} * (${multiplier}) AS "${as}"
FROM ${table} AS t`
  return {
    sql,
    columns: [plain(r.unit), plain(r.measure), plain(r.by), 'multiplier', as],
    caveats: [`${as} is ${r.measure} adjusted ${how}: a modelling choice, not data; say why (and how it was chosen: compared with correlate, or from a known difference).`],
  }
}

// ── correlate ─────────────────────────────────────────────────────────────

export function correlateSql(r: Correlate): RecipeSql {
  const [table, x, y] = [ident(r.table, 'table'), ident(r.x, 'x'), ident(r.y, 'y')]
  const g = r.group === undefined || r.group === '' ? undefined : ident(r.group, 'group')
  const sql = `-- Correlate: how well ${r.x} tracks ${r.y}${g ? `, per ${r.group}` : ''} (r² near 1: closely; the line: ${r.y} ≈ intercept + slope × ${r.x}).
SELECT ${g ? `t.${g} AS ${g}, ` : ''}regr_count(${dbl(`t.${y}`)}, ${dbl(`t.${x}`)}) AS n, corr(${dbl(`t.${y}`)}, ${dbl(`t.${x}`)}) AS r, regr_r2(${dbl(`t.${y}`)}, ${dbl(`t.${x}`)}) AS r2,
  regr_slope(${dbl(`t.${y}`)}, ${dbl(`t.${x}`)}) AS slope, regr_intercept(${dbl(`t.${y}`)}, ${dbl(`t.${x}`)}) AS intercept
FROM ${table} AS t${g ? ` GROUP BY t.${g} ORDER BY t.${g}` : ''}`
  return { sql, columns: [...(g ? [plain(r.group)] : []), 'n', 'r', 'r2', 'slope', 'intercept'], caveats: [] }
}

// ── fill (breadth) ────────────────────────────────────────────────────────

export function fillSql(r: Fill): RecipeSql {
  const [table, unit, x, y] = [ident(r.table, 'table'), ident(r.unit, 'unit'), ident(r.x, 'x'), ident(r.y, 'y')]
  const as = outName(r.as, `${plain(r.y)}_filled`.slice(0, 63), 'as')
  const sql = `-- Fill: ${r.y} where it's missing, from the line it follows against ${r.x} where both are known.
WITH d AS (SELECT t.${unit} AS unit, ${dbl(`t.${x}`)} AS x, ${dbl(`t.${y}`)} AS y FROM ${table} AS t),
fit AS (SELECT regr_slope(y, x) AS slope, regr_intercept(y, x) AS intercept, regr_r2(y, x) AS r2, regr_count(y, x) AS n FROM d),
ratios AS (SELECT quantile_cont(d.y / (fit.intercept + fit.slope * d.x), 0.1) AS lo, quantile_cont(d.y / (fit.intercept + fit.slope * d.x), 0.9) AS hi
  FROM d CROSS JOIN fit WHERE d.y IS NOT NULL AND d.x IS NOT NULL AND fit.intercept + fit.slope * d.x > 0)
SELECT d.unit AS ${unit}, d.x AS ${x}, d.y AS ${y},
  fit.intercept + fit.slope * d.x AS fitted,
  coalesce(d.y, fit.intercept + fit.slope * d.x) AS "${as}",
  d.y IS NULL AS estimated,
  CASE WHEN d.y IS NULL THEN (fit.intercept + fit.slope * d.x) * ratios.lo ELSE d.y END AS low,
  CASE WHEN d.y IS NULL THEN (fit.intercept + fit.slope * d.x) * ratios.hi ELSE d.y END AS high,
  fit.r2 AS fit_r2, fit.n AS fit_n
FROM d CROSS JOIN fit CROSS JOIN ratios`
  return {
    sql,
    columns: [plain(r.unit), plain(r.x), plain(r.y), 'fitted', as, 'estimated', 'low', 'high', 'fit_r2', 'fit_n'],
    estimate: { method: 'fill', value: as, range: { low: 'low', likely: as, high: 'high' } },
    caveats: [
      `Where ${r.y} is missing (estimated = true) it comes from the line it follows against ${r.x} where both are known (fit_r2 says how closely, over fit_n places); elsewhere it is the data itself.`,
      `low / high for estimated places: the line scaled by how far the known places typically sit from it (their 10th and 90th percentiles), not a statistical confidence interval.`,
    ],
  }
}

// ── scale (depth) ─────────────────────────────────────────────────────────

export function scaleSql(r: Scale): RecipeSql {
  const [fine, coarse, unit, parent, proxy, cparent, total] = [ident(r.fine, 'fine'), ident(r.coarse, 'coarse'), ident(r.unit, 'unit'), ident(r.parent, 'parent'), ident(r.proxy, 'proxy'), ident(r.coarseParent ?? r.parent, 'coarseParent'), ident(r.total, 'total')]
  const as = outName(r.as, `${plain(r.total)}_scaled`.slice(0, 63), 'as')
  const sql = `-- Scale: each coarse unit's ${r.total} carried to its finer units through ${r.proxy}: shared out where the total is known, from the line totals follow against summed ${r.proxy} where it isn't.
WITH f AS (SELECT ${unit} AS unit, ${parent} AS parent, coalesce(${dbl(proxy)}, 0) AS proxy FROM ${fine}),
c AS (SELECT ${cparent} AS parent, ${dbl(total)} AS total FROM ${coarse}),
agg AS (SELECT parent, sum(proxy) AS proxy_sum FROM f GROUP BY parent),
known AS (SELECT agg.parent, agg.proxy_sum, c.total FROM agg JOIN c ON agg.parent = c.parent WHERE c.total IS NOT NULL),
fit AS (SELECT regr_slope(total, proxy_sum) AS slope, regr_intercept(total, proxy_sum) AS intercept, regr_r2(total, proxy_sum) AS r2, regr_count(total, proxy_sum) AS n FROM known),
ratios AS (SELECT quantile_cont(known.total / (fit.intercept + fit.slope * known.proxy_sum), 0.1) AS lo, quantile_cont(known.total / (fit.intercept + fit.slope * known.proxy_sum), 0.9) AS hi
  FROM known CROSS JOIN fit WHERE fit.intercept + fit.slope * known.proxy_sum > 0),
p AS (SELECT agg.parent, agg.proxy_sum, c.total, fit.intercept + fit.slope * agg.proxy_sum AS fitted_total FROM agg CROSS JOIN fit LEFT JOIN c ON agg.parent = c.parent)
SELECT f.unit AS ${unit}, f.parent AS ${parent}, f.proxy AS ${proxy},
  CASE WHEN p.proxy_sum > 0 THEN f.proxy / p.proxy_sum END AS share,
  p.total AS parent_total,
  CASE WHEN p.proxy_sum > 0 THEN coalesce(p.total, p.fitted_total) * f.proxy / p.proxy_sum END AS "${as}",
  p.total IS NULL AS estimated,
  CASE WHEN p.proxy_sum > 0 THEN coalesce(p.total, p.fitted_total * ratios.lo) * f.proxy / p.proxy_sum END AS low,
  CASE WHEN p.proxy_sum > 0 THEN coalesce(p.total, p.fitted_total * ratios.hi) * f.proxy / p.proxy_sum END AS high,
  fit.r2 AS fit_r2, fit.n AS fit_n
FROM f JOIN p ON f.parent = p.parent CROSS JOIN fit CROSS JOIN ratios`
  return {
    sql,
    columns: [plain(r.unit), plain(r.parent), plain(r.proxy), 'share', 'parent_total', as, 'estimated', 'low', 'high', 'fit_r2', 'fit_n'],
    estimate: { method: 'scale', value: as, range: { low: 'low', likely: as, high: 'high' } },
    caveats: [
      `The finer units' ${r.total} is not measured: each coarse unit's total is shared out by ${r.proxy}, so they add up to it but follow the proxy's pattern inside it.`,
      `Where a coarse unit has no total (estimated = true), it comes from the line totals follow against summed ${r.proxy} (fit_r2 over fit_n coarse units); low / high spread it by how far those units sit from the line.`,
    ],
  }
}

// ── deduce (Fermi) ────────────────────────────────────────────────────────

type Node = { k: 'num'; v: number } | { k: 'name'; v: string } | { k: 'neg'; a: Node } | { k: 'op'; op: '+' | '-' | '*' | '/'; a: Node; b: Node } | { k: 'fn'; fn: 'min' | 'max'; args: Node[] }

/** Plain arithmetic: numbers, names, + − × ÷, parentheses, min(…), max(…). Anything else is refused. */
export function parseArithmetic(src: string): Node {
  const toks = src.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),×÷]|\S/g) ?? []
  let i = 0
  const peek = () => toks[i]
  const take = (t?: string) => {
    const x = toks[i++]
    if (t !== undefined && x !== t) throw new Error(`Expected "${t}" in "${src}", got ${x === undefined ? 'the end' : `"${x}"`}`)
    return x
  }
  const expr = (): Node => {
    let n = term()
    while (peek() === '+' || peek() === '-') n = { k: 'op', op: take() as '+' | '-', a: n, b: term() }
    return n
  }
  const term = (): Node => {
    let n = factor()
    while (['*', '/', '×', '÷'].includes(peek())) {
      const t = take()
      n = { k: 'op', op: t === '×' ? '*' : t === '÷' ? '/' : (t as '*' | '/'), a: n, b: factor() }
    }
    return n
  }
  const factor = (): Node => {
    const t = take()
    if (t === undefined) throw new Error(`"${src}" ends too early`)
    if (t === '-') return { k: 'neg', a: factor() }
    if (t === '(') {
      const n = expr()
      take(')')
      return n
    }
    if (/^\d/.test(t)) return { k: 'num', v: Number(t) }
    if (/^[A-Za-z_]/.test(t)) {
      if ((t === 'min' || t === 'max') && peek() === '(') {
        take('(')
        const args = [expr()]
        while (peek() === ',') take(), args.push(expr())
        take(')')
        if (args.length < 2) throw new Error(`${t}(…) needs at least two values in "${src}"`)
        return { k: 'fn', fn: t, args }
      }
      return { k: 'name', v: t }
    }
    throw new Error(`"${t}" isn't allowed in "${src}": use numbers, names, + − × ÷, parentheses, min(…) and max(…)`)
  }
  const n = expr()
  if (i < toks.length) throw new Error(`Unexpected "${toks[i]}" in "${src}"`)
  return n
}

/** An interval's SQL: low, likely and high. */
type Iv = { lo: string; mid: string; hi: string }
function compile(n: Node, resolve: (name: string) => Iv): Iv {
  switch (n.k) {
    case 'num': {
      const v = `CAST(${n.v} AS DOUBLE)`
      return { lo: v, mid: v, hi: v }
    }
    case 'name':
      return resolve(n.v)
    case 'neg': {
      const a = compile(n.a, resolve)
      return { lo: `(-${a.hi})`, mid: `(-${a.mid})`, hi: `(-${a.lo})` }
    }
    case 'fn': {
      const xs = n.args.map((x) => compile(x, resolve))
      const f = n.fn === 'min' ? 'least' : 'greatest'
      return { lo: `${f}(${xs.map((x) => x.lo).join(', ')})`, mid: `${f}(${xs.map((x) => x.mid).join(', ')})`, hi: `${f}(${xs.map((x) => x.hi).join(', ')})` }
    }
    case 'op': {
      const a = compile(n.a, resolve)
      const b = compile(n.b, resolve)
      if (n.op === '+') return { lo: `(${a.lo} + ${b.lo})`, mid: `(${a.mid} + ${b.mid})`, hi: `(${a.hi} + ${b.hi})` }
      if (n.op === '-') return { lo: `(${a.lo} - ${b.hi})`, mid: `(${a.mid} - ${b.mid})`, hi: `(${a.hi} - ${b.lo})` }
      // × and ÷: the extremes of the four corner combinations (a range that may hold any sign).
      const corners = [`${a.lo} ${n.op} ${b.lo}`, `${a.lo} ${n.op} ${b.hi}`, `${a.hi} ${n.op} ${b.lo}`, `${a.hi} ${n.op} ${b.hi}`].map((c) => `(${c})`)
      return { lo: `least(${corners.join(', ')})`, mid: `(${a.mid} ${n.op} ${b.mid})`, hi: `greatest(${corners.join(', ')})` }
    }
  }
}

export function deduceSql(r: Deduce): RecipeSql {
  const base = ident(r.base, 'base')
  const unit = ident(r.unit, 'unit')
  if (!Array.isArray(r.steps) || !r.steps.length) throw new Error('A deduction needs at least one step')
  const steps = new Map<string, Iv>()
  const cols: string[] = []
  /** One layer per step: each reads the finished columns of the steps before it (an alias chain in one SELECT is inlined by DuckDB and grows exponentially). */
  const layers: string[][] = []
  const col = (name: string, part: 'low' | 'likely' | 'high') => `"${name}_${part}"`
  r.steps.forEach((s, i) => {
    const w = `steps[${i}]`
    ident(s?.name, `${w}.name`)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name)) throw new Error(`${w}.name must be one word (letters, digits, _): it's used in later steps`)
    if (steps.has(s.name)) throw new Error(`${w}.name "${s.name}" is used twice`)
    const resolve = (name: string): Iv => {
      const known = steps.get(name)
      if (known) return known
      ident(name, 'a name in a step')
      const c = dbl(`"${name}"`)
      return { lo: c, mid: c, hi: c }
    }
    const leaf = (v: unknown, what: string): string => (typeof v === 'number' ? num(v, what) : typeof v === 'string' && v.trim() ? compile(parseArithmetic(v), resolve).mid : (() => { throw new Error(`${what} must be a number, a column or arithmetic`) })())
    let iv: Iv
    if (s.expr !== undefined) {
      if (typeof s.expr !== 'string' || !s.expr.trim()) throw new Error(`${w}.expr must be arithmetic over numbers, columns and earlier steps`)
      iv = compile(parseArithmetic(s.expr), resolve)
    } else {
      if (s.likely === undefined) throw new Error(`${w} needs expr, or low / likely / high`)
      iv = { lo: leaf(s.low ?? s.likely, `${w}.low`), mid: leaf(s.likely, `${w}.likely`), hi: leaf(s.high ?? s.likely, `${w}.high`) }
    }
    layers.push([`${iv.lo} AS ${col(s.name, 'low')}`, `${iv.mid} AS ${col(s.name, 'likely')}`, `${iv.hi} AS ${col(s.name, 'high')}`])
    cols.push(`${s.name}_low`, `${s.name}_likely`, `${s.name}_high`)
    // Later steps read this one's columns (DuckDB lets a column refer to one named before it).
    steps.set(s.name, { lo: col(s.name, 'low'), mid: col(s.name, 'likely'), hi: col(s.name, 'high') })
  })
  let estimate: DatasetEstimate
  const last = r.steps[r.steps.length - 1].name
  if (r.meet) {
    const { a, b } = r.meet
    if (!steps.has(a) || !steps.has(b)) throw new Error(`meet must name two of the steps (got ${JSON.stringify(a)} and ${JSON.stringify(b)})`)
    const as = outName(r.meet.as, 'met', 'meet.as')
    const [A, B] = [steps.get(a)!, steps.get(b)!]
    layers.push([
      `  greatest(${A.lo}, ${B.lo}) AS "${as}_low"`,
      `  CASE WHEN ${A.mid} > 0 AND ${B.mid} > 0 THEN sqrt(${A.mid} * ${B.mid}) ELSE (${A.mid} + ${B.mid}) / 2 END AS "${as}_likely"`,
      `  least(${A.hi}, ${B.hi}) AS "${as}_high"`,
      `  ${A.mid} / nullif(${B.mid}, 0) AS agreement`,
      `  greatest(${A.lo}, ${B.lo}) <= least(${A.hi}, ${B.hi}) AS overlap`,
    ])
    cols.push(`${as}_low`, `${as}_likely`, `${as}_high`, 'agreement', 'overlap')
    estimate = { method: 'deduce', value: `${as}_likely`, range: { low: `${as}_low`, likely: `${as}_likely`, high: `${as}_high` } }
  } else estimate = { method: 'deduce', value: `${last}_likely`, range: { low: `${last}_low`, likely: `${last}_likely`, high: `${last}_high` } }
  const sql = `-- Deduce: ${r.steps.map((s) => (s.expr ? `${s.name} = ${s.expr}` : `${s.name} (assumed)`)).join('; ')}${r.meet ? `; ${r.meet.a} and ${r.meet.b} meet` : ''}. Each low / likely / high.
WITH s0 AS (SELECT * FROM ${base}),
${layers.map((l, i) => `s${i + 1} AS (SELECT *, ${l.map((x) => x.trim()).join(', ')} FROM s${i})`).join(',\n')}
SELECT ${unit}, ${cols.map((c) => `"${c}"`).join(', ')} FROM s${layers.length}`
  return {
    sql,
    columns: [plain(r.unit), ...cols],
    estimate,
    caveats: [
      `Deduced, not measured: a chain of steps from what is known, each a range (low / likely / high); the assumptions are listed with it. The low and high carry every step's own range through, so they are wide on purpose.`,
      ...(r.meet ? [`${r.meet.a} and ${r.meet.b} reach the same unknown from two sides: the range is where they overlap (overlap = false where they don't), agreement = their likely values' ratio (1 = they agree).`] : []),
    ],
  }
}

/** The SQL for any piece (throws a readable Error on a bad name or a missing part). */
export function recipeSql(r: Recipe): RecipeSql {
  switch (r?.kind) {
    case 'composite':
      return compositeSql(r)
    case 'adjust':
      return adjustSql(r)
    case 'correlate':
      return correlateSql(r)
    case 'fill':
      return fillSql(r)
    case 'scale':
      return scaleSql(r)
    case 'deduce':
      return deduceSql(r)
    default:
      throw new Error(`kind must be one of ${RECIPE_KINDS.join(', ')}`)
  }
}

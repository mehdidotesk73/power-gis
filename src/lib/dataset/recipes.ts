// Reconciliation and Fermi recipes (pure, used by the assistant's recipe tool): SQL for a transform, from the names of the
// tables (a transform's input aliases) and columns, about any places and any
// measure. Each recipe answers the SQL plus what its output's metadata should
// record (shared/records.ts DatasetEstimate): how it was made and how far to
// trust it, so the story can say so.
//
// - Top-down: a coarse total (a country's, a state's) spread over the finer
//   units inside it in proportion to a proxy weight; the units add back up to
//   the total.
// - Bottom-up: finer units scored from proxies; the scores summed per coarse
//   unit are fitted against the coarse truth (a line, least squares); the fit
//   is applied back to every unit, raked to the truth where it is known; the
//   spread of the coarse units around the line gives each unit a low / high.
// - Fermi: a first-principles estimate per unit, a base quantity times
//   factors each given as low / likely / high (numbers or columns); the
//   output is low / likely / high (lows multiplied together, and so on: a
//   deliberately wide range).

import type { DatasetEstimate } from '../../shared/records'

export type RecipeKind = 'top-down' | 'bottom-up' | 'fermi'

export interface TopDown {
  kind: 'top-down'
  /** The fine table (alias), one row per fine unit. */
  fine: string
  unit: string
  /** The column naming the coarse unit each fine unit is in. */
  parent: string
  /** The proxy the total is spread by (population, area, jobs…). */
  weight: string
  /** The coarse table (alias): one row per coarse unit, with its total. */
  coarse: string
  /** The coarse table's own column for the coarse unit (default: the same name as `parent`). */
  coarseParent?: string
  total: string
  /** The output column's name (default "estimate"). */
  as?: string
}

export interface BottomUp {
  kind: 'bottom-up'
  fine: string
  unit: string
  parent: string
  /** The fine units' score from proxies (any scale: the fit sets it). */
  score: string
  coarse: string
  coarseParent?: string
  /** The coarse units' known value (the truth the scores are fitted to). */
  truth: string
  as?: string
}

/** A factor of a Fermi estimate: a number, or a column of the base table, for each of low / likely / high. */
export interface FermiFactor {
  name: string
  low: number | string
  likely: number | string
  high: number | string
}
export interface Fermi {
  kind: 'fermi'
  /** The table (alias) whose rows are the units estimated. */
  base: string
  unit: string
  /** The base quantity per unit (a column), multiplied by every factor; omit for factors alone. */
  quantity?: string
  factors: FermiFactor[]
}

export type Recipe = TopDown | BottomUp | Fermi

export interface RecipeSql {
  sql: string
  /** The output's columns, in order. */
  columns: string[]
  /** What the output dataset's metadata.estimate starts from (the assistant adds assumptions and the fit it reads). */
  estimate: DatasetEstimate
  /** Caveats every output of this recipe carries. */
  caveats: string[]
}

const NAME = /^[A-Za-z_][A-Za-z0-9_ ]{0,62}$/
/** A table or column name, quoted for SQL; anything else is refused (recipes never take SQL text). */
export function ident(name: unknown, what: string): string {
  if (typeof name !== 'string' || !NAME.test(name.trim())) throw new Error(`${what} must be a table or column name (letters, digits, _), got ${JSON.stringify(name)}`)
  return `"${name.trim()}"`
}
const outName = (v: unknown, fallback: string, what: string) => (v === undefined || v === '' ? fallback : (ident(v, what), String(v).trim()))
/** A Fermi factor's value: a number inline, a column of the base table quoted. */
function term(v: unknown, what: string): string {
  if (typeof v === 'number' && Number.isFinite(v)) return `CAST(${v} AS DOUBLE)`
  return `CAST(b.${ident(v, what)} AS DOUBLE)`
}

export function topDownSql(r: TopDown): RecipeSql {
  const [fine, coarse, unit, parent, weight, cparent, total] = [ident(r.fine, 'fine'), ident(r.coarse, 'coarse'), ident(r.unit, 'unit'), ident(r.parent, 'parent'), ident(r.weight, 'weight'), ident(r.coarseParent ?? r.parent, 'coarseParent'), ident(r.total, 'total')]
  const as = outName(r.as, 'estimate', 'as')
  const sql = `-- Top-down: each coarse unit's ${r.total} spread over its finer units in proportion to ${r.weight}.
WITH f AS (SELECT ${unit} AS unit, ${parent} AS parent, coalesce(CAST(${weight} AS DOUBLE), 0) AS weight FROM ${fine}),
c AS (SELECT ${cparent} AS parent, CAST(${total} AS DOUBLE) AS total FROM ${coarse}),
s AS (SELECT parent, sum(weight) AS weight_sum FROM f GROUP BY parent)
SELECT f.unit AS ${unit}, f.parent AS ${parent}, f.weight AS ${weight},
  CASE WHEN s.weight_sum > 0 THEN f.weight / s.weight_sum END AS share,
  c.total AS parent_total,
  CASE WHEN s.weight_sum > 0 THEN c.total * f.weight / s.weight_sum END AS "${as}"
FROM f JOIN s ON f.parent = s.parent LEFT JOIN c ON f.parent = c.parent`
  return {
    sql,
    columns: [r.unit, r.parent, r.weight, 'share', 'parent_total', as],
    estimate: { method: 'top-down', value: as },
    caveats: [
      `The finer units' values are not measured: each coarse unit's ${r.total} is shared out in proportion to ${r.weight}, so they add up to the coarse total but follow the proxy's pattern inside it.`,
      `Units in a coarse unit without a total are left empty.`,
    ],
  }
}

export function bottomUpSql(r: BottomUp): RecipeSql {
  const [fine, coarse, unit, parent, score, cparent, truth] = [ident(r.fine, 'fine'), ident(r.coarse, 'coarse'), ident(r.unit, 'unit'), ident(r.parent, 'parent'), ident(r.score, 'score'), ident(r.coarseParent ?? r.parent, 'coarseParent'), ident(r.truth, 'truth')]
  const as = outName(r.as, 'estimate', 'as')
  const sql = `-- Bottom-up: ${r.score} summed per coarse unit, fitted against ${r.truth} (a line, least squares), applied back to each unit.
WITH f AS (SELECT ${unit} AS unit, ${parent} AS parent, CAST(${score} AS DOUBLE) AS score FROM ${fine}),
c AS (SELECT ${cparent} AS parent, CAST(${truth} AS DOUBLE) AS truth FROM ${coarse}),
agg AS (SELECT parent, sum(score) AS score_sum FROM f GROUP BY parent),
known AS (SELECT agg.parent, agg.score_sum, c.truth FROM agg JOIN c ON agg.parent = c.parent WHERE c.truth IS NOT NULL AND agg.score_sum IS NOT NULL),
fit AS (SELECT regr_slope(truth, score_sum) AS slope, regr_intercept(truth, score_sum) AS intercept, regr_r2(truth, score_sum) AS r2, count(*) AS n FROM known),
ratios AS (SELECT quantile_cont(known.truth / (fit.intercept + fit.slope * known.score_sum), 0.1) AS lo, quantile_cont(known.truth / (fit.intercept + fit.slope * known.score_sum), 0.9) AS hi
  FROM known CROSS JOIN fit WHERE fit.intercept + fit.slope * known.score_sum > 0),
p AS (SELECT agg.parent, agg.score_sum, c.truth, fit.intercept + fit.slope * agg.score_sum AS fitted_total FROM agg CROSS JOIN fit LEFT JOIN c ON agg.parent = c.parent)
SELECT f.unit AS ${unit}, f.parent AS ${parent}, f.score AS ${score},
  CASE WHEN p.score_sum <> 0 THEN p.fitted_total * f.score / p.score_sum END AS fitted,
  CASE WHEN p.score_sum <> 0 THEN coalesce(p.truth, p.fitted_total) * f.score / p.score_sum END AS "${as}",
  CASE WHEN p.score_sum <> 0 THEN p.fitted_total * f.score / p.score_sum * ratios.lo END AS low,
  CASE WHEN p.score_sum <> 0 THEN p.fitted_total * f.score / p.score_sum * ratios.hi END AS high,
  p.truth IS NOT NULL AS parent_known,
  p.truth / nullif(p.fitted_total, 0) AS parent_ratio,
  fit.r2 AS fit_r2, fit.n AS fit_units
FROM f JOIN p ON f.parent = p.parent CROSS JOIN fit CROSS JOIN ratios`
  return {
    sql,
    columns: [r.unit, r.parent, r.score, 'fitted', as, 'low', 'high', 'parent_known', 'parent_ratio', 'fit_r2', 'fit_units'],
    estimate: { method: 'bottom-up', value: as, range: { low: 'low', likely: as, high: 'high' } },
    caveats: [
      `Modelled, not measured: ${r.score} is fitted against ${r.truth} over the coarse units that have it (fit_r2 says how well, 1 = perfectly), then shared out by score. Where the coarse truth is known the units add up to it; elsewhere they follow the fitted line.`,
      `low / high: the fitted value scaled by how far the coarse units typically sit from the line (their 10th and 90th percentiles), not a statistical confidence interval.`,
    ],
  }
}

export function fermiSql(r: Fermi): RecipeSql {
  const base = ident(r.base, 'base')
  const unit = ident(r.unit, 'unit')
  if (!Array.isArray(r.factors) || !r.factors.length) throw new Error('A Fermi estimate needs at least one factor')
  r.factors.forEach((f, i) => ident(f?.name, `factors[${i}].name`))
  const q = r.quantity ? [`CAST(b.${ident(r.quantity, 'quantity')} AS DOUBLE)`] : []
  const product = (k: 'low' | 'likely' | 'high') => [...q, ...r.factors.map((f, i) => term(f[k], `factors[${i}].${k}`))].join(' * ')
  const sql = `-- Fermi: ${[r.quantity, ...r.factors.map((f) => f.name)].filter(Boolean).join(' × ')}, each as low / likely / high (lows together, highs together: a wide range).
SELECT b.${unit} AS ${unit},
  ${product('low')} AS low,
  ${product('likely')} AS likely,
  ${product('high')} AS high
FROM ${base} AS b`
  return {
    sql,
    columns: [r.unit, 'low', 'likely', 'high'],
    estimate: { method: 'fermi', value: 'likely', range: { low: 'low', likely: 'likely', high: 'high' } },
    caveats: [
      `An estimate from first principles, not data: ${[r.quantity, ...r.factors.map((f) => f.name)].filter(Boolean).join(' × ')}. Its assumptions are listed with it; low and high multiply the factors' own lows and highs, so the true value should lie inside, and the likely value is a best guess.`,
    ],
  }
}

/** The SQL for any recipe (throws a readable Error on a bad name or a missing part). */
export function recipeSql(r: Recipe): RecipeSql {
  switch (r?.kind) {
    case 'top-down':
      return topDownSql(r)
    case 'bottom-up':
      return bottomUpSql(r)
    case 'fermi':
      return fermiSql(r)
    default:
      throw new Error('kind must be "top-down", "bottom-up" or "fermi"')
  }
}

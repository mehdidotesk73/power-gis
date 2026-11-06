// Estimation pieces (lib/dataset/recipes.ts): composite, adjust, correlate, fill, scale, deduce.
// Each tool: its spec (what the model sees) next to its handler (what runs).

import type { ToolOutcome } from '../../lib/agent/loop'
import type { ToolSpec } from '../../lib/agent/provider'
import { recipeSql, type Recipe, type RecipeSql } from '../../lib/dataset/recipes'
import { Obj, err, ok } from './common'

export const RECIPE_TOOLS: ToolSpec[] = [
  {
    name: 'recipe',
    description:
      "Small estimation pieces that compose, for any places and measure: each gives the SQL for a transform output (correlate: a query to run with query_sql), from table and column names (input aliases), never SQL text. Chain them, or write your own SQL when that fits better. composite: several measures into one index (each a percentile with its direction, then a weighted mean): 'tech-savvy' from education, tech jobs and exports. adjust: a measure scaled by a broader property of each place, a class (factors: {urban: 1.2, rural: 0.9}; elevation band; industrialized) or an index (strength): population adjusted for tech-savviness. correlate: how well x tracks y at the same unit (r², the line, n), optionally per class: compare candidate sides before using one. fill (breadth): y's gaps filled from the line it follows against x, same unit (Netflix revenue for states that don't report it, from adjusted population). scale (depth): a coarse unit's total carried to its finer units through a proxy, shared out where the total is known and from the line totals follow against the summed proxy where it isn't. deduce (Fermi): a chain of steps, each an assumption (low / likely / high: numbers or columns) or arithmetic over earlier steps, columns and numbers (+ - * / ( ), min, max for physical limits), carried as ranges; meet: two steps reaching the same unknown from two sides (demand and supply) — their overlap and agreement. Estimates (fill, scale, deduce) come with the metadata their output carries: add the assumptions and the fit you read.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['composite', 'adjust', 'correlate', 'fill', 'scale', 'deduce'] },
        table: { type: 'string', description: 'composite / adjust / correlate / fill: the table (input alias).' },
        unit: { type: 'string', description: "The unit's column (in table, fine or base)." },
        as: { type: 'string', description: "The output column's name (optional)." },
        parts: { type: 'array', description: 'composite: the measures combined.', items: { type: 'object', properties: { column: { type: 'string' }, weight: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down'] } }, required: ['column'] } },
        measure: { type: 'string', description: 'adjust: the measure adjusted.' },
        by: { type: 'string', description: 'adjust: the class or index column it is adjusted by.' },
        factors: { type: 'object', description: 'adjust (class): each class\'s multiplier, e.g. {"urban": 1.2, "rural": 0.9}; others keep 1.', additionalProperties: { type: 'number' } },
        strength: { type: 'number', description: 'adjust (index): measure × (1 + strength × (index − its mean)).' },
        x: { type: 'string', description: 'correlate / fill: the side known everywhere (a measure or a composite / adjusted one).' },
        y: { type: 'string', description: 'correlate / fill: the measure tracked, with gaps for fill.' },
        group: { type: 'string', description: 'correlate: one line per class instead of one overall.' },
        fine: { type: 'string', description: 'scale: the fine table, one row per finer unit.' },
        parent: { type: 'string', description: 'scale: the fine column naming the coarse unit each is in.' },
        proxy: { type: 'string', description: "scale: the finer units' proxy." },
        coarse: { type: 'string', description: 'scale: the coarse table, one row per coarse unit.' },
        coarseParent: { type: 'string', description: "scale: the coarse table's column for the coarse unit, when not named like parent." },
        total: { type: 'string', description: 'scale: the coarse total column.' },
        base: { type: 'string', description: 'deduce: the table whose rows are the units deduced for.' },
        steps: {
          type: 'array',
          description: 'deduce: in order; each {name, expr} or {name, low, likely, high}.',
          items: { type: 'object', properties: { name: { type: 'string' }, expr: { type: 'string' }, low: { type: ['number', 'string'] }, likely: { type: ['number', 'string'] }, high: { type: ['number', 'string'] } }, required: ['name'] },
        },
        meet: { type: 'object', description: 'deduce: two steps estimating the same unknown from two sides.', properties: { a: { type: 'string' }, b: { type: 'string' }, as: { type: 'string' } }, required: ['a', 'b'] },
      },
      required: ['kind'],
    },
  },
]

/** The recipe tool: SQL for a top-down, bottom-up or Fermi estimate, and what its output's metadata should say. */
export function recipe(input: Obj): ToolOutcome {
  let r: RecipeSql
  try {
    r = recipeSql(input as unknown as Recipe)
  } catch (e) {
    return err(`${(e as Error).message}. Nothing was made.`, 'refused: bad recipe')
  }
  return ok(
    {
      sql: r.sql,
      columns: r.columns,
      ...(r.estimate ? { metadata: { estimate: r.estimate, caveats: r.caveats } } : r.caveats.length ? { caveats: r.caveats } : {}),
      next:
        input.kind === 'correlate'
          ? 'Run this with query_sql (it changes nothing). Compare candidate sides the same way (a raw measure, an adjusted one, a composite) and keep the one that tracks best and makes sense; say which and why.'
          : `Put the SQL in a transform's output (its inputs aliased as named here), run it and query the output.${r.estimate ? ` Give the output a description and this metadata, adding the estimate's assumptions${r.estimate.method === 'deduce' ? ' (every assumed step and why that range)' : ' and its fit (fit_r2 over fit_n, how wide low–high runs)'}` : ' Put these caveats in its metadata'}, and say in the transform's description what this step does and why.`,
    },
    `${input.kind} recipe`,
  )
}

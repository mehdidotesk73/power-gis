// The workspace as the agent reads and edits it: JSON text in which every
// transform output's SQL is a token (`${sql:<transform id>.<output key>}`),
// with the SQL itself listed apart as plain text. Edits are exact
// replacements: of text in the JSON, or of text inside one SQL block. New
// text may name the agent's own values (`${name}`), which are put in as JSON
// literals here, so the model never writes SQL inside a JSON string (the
// escaping it got wrong). The result is parsed and checked by the tools like
// any workspace (tools.ts).

import type { VisualizationSpec } from '../dataset/visualization'
import type { ColorEncoding } from '../style'
import type { TransformSpec, WorkspaceDoc } from '../workspace/workspace'

type Obj = Record<string, unknown>

/** A color as the agent sees and writes it. */
export function agentColor(c: ColorEncoding): Obj {
  if (c.kind === 'colormap') return { kind: c.kind, colormap: c.colormap, ...(c.reverse ? { reverse: true } : {}), ...(c.scale === 'log' ? { scale: 'log' } : {}), ...(c.domain ? { domain: c.domain } : {}) }
  if (c.kind === 'categorical') return { kind: c.kind, ...(c.palette ? { palette: c.palette } : {}) }
  return { kind: c.kind, color: c.color }
}

export const agentTransform = (t: TransformSpec): Obj => ({
  id: t.id,
  name: t.name,
  inputs: t.inputs.map((i) => ({ datasetId: i.datasetId, alias: i.alias })),
  outputs: t.outputs.map((o) => ({ key: o.key, name: o.name, sql: o.sql, ...(o.outputId ? { outputId: o.outputId } : {}) })),
})

export const agentVisualization = (v: VisualizationSpec): Obj => ({
  id: v.id,
  name: v.name,
  datasetId: v.datasetId,
  geometry: v.binding.column,
  ...(v.binding.label ? { label: v.binding.label } : {}),
  column: v.column,
  aggregation: v.aggregation,
  visible: v.visible,
  color: agentColor(v.style.color),
  ...(v.kind === 'scalar' && v.style.opacity.kind === 'constant' ? { opacity: v.style.opacity.value } : {}),
})

/** The workspace's editable contents, in the shape the tools read back. */
export const agentWorkspace = (doc: WorkspaceDoc): Obj => ({
  name: doc.name,
  datasetIds: [...doc.datasetIds],
  transforms: doc.transforms.map(agentTransform),
  visualizations: doc.visualizations.map(agentVisualization),
})

/** JSON with keys in a fixed order, to tell whether an item changed. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Obj)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export interface WorkspaceText {
  /** Pretty JSON with `${sql:…}` tokens where the SQL goes. */
  template: string
  /** Each SQL block by name (`<transform id>.<output key>`). */
  sql: Map<string, string>
}

const MARK = '\u0001'
/** `${name}` — a SQL block (`sql:…`) or one of the agent's values. */
const TOKEN = /\$\{([A-Za-z_][\w:.-]*)\}/g

export function renderWorkspace(doc: WorkspaceDoc): WorkspaceText {
  const sql = new Map<string, string>()
  const obj = agentWorkspace(doc)
  for (const t of obj.transforms as Obj[]) {
    for (const o of t.outputs as Obj[]) {
      const name = `${t.id}.${o.key}`
      sql.set(name, o.sql as string)
      o.sql = `${MARK}${name}${MARK}`
    }
  }
  // A literal "${" in a name or label is written {-escaped, so only tokens read as tokens.
  const template = JSON.stringify(obj, null, 2)
    .replace(/\$\{/g, '$\\u007b')
    .replace(/"\\u0001([^"\\]+)\\u0001"/g, (_, name: string) => `\${sql:${name}}`)
  return { template, sql }
}

/** The workspace as get_workspace shows it: the template, then each SQL block as plain text. */
export function workspaceTextBlock(w: WorkspaceText): string {
  const blocks = [...w.sql].map(([name, sql]) => `--- sql:${name} ---\n${sql}`)
  return `${w.template}\n\nSQL blocks (plain SQL, as it runs):\n${blocks.length ? blocks.join('\n\n') : '(none)'}`
}

export interface TextEdit {
  /** Exact text to replace; must occur once. */
  old: string
  /** What replaces it; may name values (`${name}`) and SQL blocks (`${sql:…}`). */
  new: string
  /** Edit inside this SQL block (`<transform id>.<output key>`, `sql:` optional) instead of the JSON. */
  sql?: string
}

export type EditResult = { ok: true; value: unknown; sql: Map<string, string> } | { ok: false; errors: string[] }

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s)
const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0)

/**
 * Applies the edits in order (each sees the ones before), then puts the SQL
 * blocks and values into the template and parses it. All or nothing: every
 * problem is listed.
 */
export function applyWorkspaceEdits(w: WorkspaceText, edits: TextEdit[], values: Obj = {}): EditResult {
  const errors: string[] = []
  let template = w.template
  const sql = new Map(w.sql)
  edits.forEach((e, i) => {
    const where = `edits[${i}]`
    if (!e.old) return void errors.push(`${where}: "old" is empty — give the exact text to replace`)
    const block = e.sql?.replace(/^sql:/, '')
    if (block !== undefined && !sql.has(block)) return void errors.push(`${where}: no SQL block "${e.sql}" (get_workspace lists them, e.g. "${[...sql.keys()][0] ?? 'transformId.key'}")`)
    const text = block !== undefined ? sql.get(block)! : template
    const n = count(text, e.old)
    if (n === 0) {
      return void errors.push(`${where}: "${clip(e.old)}" isn't in the ${block !== undefined ? `SQL block ${block}` : 'workspace text'}. Copy it exactly from get_workspace (spaces and line breaks too)${block === undefined && /\\"|SELECT|FROM/i.test(e.old) ? '; SQL lives in the SQL blocks: edit those with "sql"' : ''}.`)
    }
    if (n > 1) return void errors.push(`${where}: "${clip(e.old)}" occurs ${n} times; include more of the text around it (an id or name) so it occurs once.`)
    const next = text.replace(e.old, () => e.new)
    if (block !== undefined) sql.set(block, next)
    else template = next
  })
  // Tokens are filled in one pass: SQL and values put in are never read for tokens again.
  const filled = template.replace(TOKEN, (whole, name: string) => {
    if (name.startsWith('sql:')) {
      const s = sql.get(name.slice(4))
      if (s === undefined) errors.push(`${whole}: no such SQL block`)
      return JSON.stringify(s ?? '')
    }
    if (!(name in values)) {
      errors.push(`${whole}: no value "${name}" (give it in "values")`)
      return 'null'
    }
    return JSON.stringify(values[name])
  })
  if (errors.length) return { ok: false, errors }
  try {
    return { ok: true, value: JSON.parse(filled), sql }
  } catch (e) {
    return { ok: false, errors: [`After the edits the workspace isn't valid JSON (${(e as Error).message}). Check commas, brackets and quotes around what you changed.`] }
  }
}

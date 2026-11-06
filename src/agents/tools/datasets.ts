// Datasets beyond the workspace: list them, add a built-in, delete one the agent made.
// Each tool: its spec (what the model sees) next to its handler (what runs).

import { type DatasetRecord } from '../../shared/records'
import type { ToolOutcome } from '../../lib/agent/loop'
import type { ToolSpec } from '../../lib/agent/provider'
import { Obj, err, need, ok, plural, storeLabel, str } from './common'
import { AgentHost } from './host'
import { made, pendingEdits } from './workspace'

export const DATASETS_TOOLS: ToolSpec[] = [
  {
    name: 'list_datasets',
    description:
      "Every dataset the user can use, including those outside the workspace, local and cloud: id, name, description, what a row is, source, period, coverage and caveats, store, origin, row count, inWorkspace; and the built-in geographic tables that ship with the app (US state and county boundaries), under builtins: add one with add_builtin, no web needed. Use it when the workspace doesn't hold what the request needs, and before any scouting: a dataset that is exactly the data a need asks for (judge from these facts, then query a sample) is used instead of a web run. Reading needs no OK; say so when you add one to the workspace.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_builtin',
    description:
      'Add one of the built-in geographic tables (list_datasets → builtins: US state or county boundaries) to the workspace: instant and free. Returns its dataset id.',
    inputSchema: { type: 'object', properties: { table: { type: 'string', description: 'The built-in table name, e.g. us_states.' } }, required: ['table'] },
  },
  {
    name: 'delete_dataset',
    description:
      'Delete a dataset\'s copy on this device and its rows for good (and its visualizations); a linked dataset\'s cloud copy stays. Refused while a workspace transform reads it. Use it to clean up datasets you made in this chat that are no longer needed; one you didn\'t make only when the user asked for it by name (userAsked).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userAsked: { type: 'boolean', description: 'The user asked, by name, for this dataset to be deleted.' } }, required: ['id'] },
  },
]

/** A dataset's metadata, in brief: what a row is, its source, period and coverage, its caveats. */
export function metadataFacts(m: DatasetRecord['metadata']): Record<string, unknown> {
  if (!m) return {}
  const src = m.source ?? {}
  const source = [src.publisher, src.title].filter(Boolean).join(': ')
  return {
    ...(m.row ? { row: m.row } : {}),
    ...(source ? { source } : {}),
    ...(src.period ? { period: src.period } : {}),
    ...(src.coverage ? { coverage: src.coverage } : {}),
    ...(m.caveats?.length ? { caveats: m.caveats } : {}),
  }
}

export async function listDatasets(host: AgentHost): Promise<ToolOutcome> {
  const inWorkspace = new Set(host.doc().datasetIds)
  const all = await host.listDatasets()
  const data = all.map((d) => ({
    id: d.id,
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    // Enough to judge whether it's exactly the data a need asks for (then query a sample to be sure).
    ...metadataFacts(d.metadata),
    store: storeLabel(d),
    origin: d.origin,
    rows: d.rowCount,
    inWorkspace: inWorkspace.has(d.id),
  }))
  const builtins = host.builtins?.() ?? []
  const shown = builtins.length ? { datasets: data, builtins: builtins.map((b) => ({ table: b.table, name: b.label, description: b.description })) } : data
  return ok(shown, `${plural(data.length, 'dataset')} (${data.filter((d) => d.store === 'local').length} local)${builtins.length ? ` · ${plural(builtins.length, 'built-in table')}` : ''}`)
}

export async function addBuiltin(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.table) && input.table.trim(), '`table` is required')
  const known = host.builtins?.() ?? []
  const b = known.find((x) => x.table === input.table)
  if (!b || !host.addBuiltin) return err(`No built-in table "${input.table}"${known.length ? ` (there are: ${known.map((x) => x.table).join(', ')})` : ''}`)
  const r = await host.addBuiltin(b.table)
  if (!r.ok) return err(r.message)
  made(host).add(r.id)
  return ok({ datasetId: r.id, name: b.label }, `added ${b.label}`)
}

export async function deleteDataset(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.id), '`id` is required')
  const d = await host.dataset(input.id)
  need(d, `No dataset "${input.id}"`)
  const pending = pendingEdits(host)
  if (pending) return pending
  const reader = host.doc().transforms.find((t) => t.inputs.some((i) => i.datasetId === d.id))
  if (reader) return err(`Transform "${reader.name}" reads "${d.name}"; change or remove that transform first.`, 'refused: still used')
  if (!made(host).has(d.id) && input.userAsked !== true)
    return err(`"${d.name}" isn't a dataset you made in this chat: delete it only if the user asked for it by name (then set userAsked).`, 'refused: not yours')
  const r = await host.deleteDataset(d.id)
  if (!r.ok) return err(r.message)
  return ok({ deleted: d.id }, `deleted ${d.name}`)
}

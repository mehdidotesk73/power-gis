// What stands behind a set of visualizations: their datasets, the transforms
// that made them, those transforms' inputs, and so on back to the starting
// data — each step once, in order from the start to the maps. The storyteller
// reads it (as text) instead of exploring the workspace itself.

import type { WorkspaceDoc, TransformSpec } from '../workspace/workspace'
import type { VisualizationSpec } from '../dataset/visualization'
import type { DatasetRecord } from '../../shared/records'

export type LineageStep = { kind: 'dataset'; id: string } | { kind: 'transform'; transform: TransformSpec }

export interface Lineage {
  /** Datasets and transforms, inputs before what they feed. */
  steps: LineageStep[]
  visualizations: VisualizationSpec[]
}

export function lineageOf(doc: WorkspaceDoc, visualizationIds: string[]): Lineage {
  const visualizations = visualizationIds.flatMap((id) => doc.visualizations.find((v) => v.id === id) ?? [])
  const writer = (datasetId: string) => doc.transforms.find((t) => t.outputs.some((o) => o.outputId === datasetId))
  const steps: LineageStep[] = []
  const seen = new Set<string>()
  const visitDataset = (id: string) => {
    if (seen.has(`ds:${id}`)) return
    seen.add(`ds:${id}`)
    const t = writer(id)
    if (t) visitTransform(t)
    steps.push({ kind: 'dataset', id })
  }
  const visitTransform = (t: TransformSpec) => {
    if (seen.has(`tr:${t.id}`)) return
    seen.add(`tr:${t.id}`)
    for (const i of t.inputs) visitDataset(i.datasetId)
    steps.push({ kind: 'transform', transform: t })
  }
  for (const v of visualizations) visitDataset(v.datasetId)
  return { steps, visualizations }
}

const MAX_DESCRIPTION = 1500

/** The lineage as text for the storyteller: every dataset's facts and description, every transform's SQL, every visualization's settings. */
export function lineageText(l: Lineage, record: (id: string) => DatasetRecord | undefined): string {
  const name = (id: string) => record(id)?.name ?? id
  const out: string[] = ['# What stands behind these visualizations, from the starting data to the maps', '']
  for (const s of l.steps) {
    if (s.kind === 'dataset') {
      const d = record(s.id)
      if (!d) {
        out.push(`## Dataset ${s.id} (not on this device)`, '')
        continue
      }
      out.push(`## Dataset "${d.name}" (id ${d.id})`, `${d.rowCount.toLocaleString()} rows · origin: ${d.origin}`)
      out.push(`Columns: ${d.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`)
      if (d.description) out.push(`Description:\n${d.description.length > MAX_DESCRIPTION ? `${d.description.slice(0, MAX_DESCRIPTION)}…` : d.description}`)
      else out.push('Description: (none)')
      out.push('')
    } else {
      const t = s.transform
      out.push(`## Transform "${t.name}" (id ${t.id})`, `Inputs: ${t.inputs.map((i) => `${i.alias} = "${name(i.datasetId)}" (${i.datasetId})`).join(', ')}`)
      for (const o of t.outputs) out.push(`Output "${o.name}" → ${o.outputId ? `dataset "${name(o.outputId)}" (${o.outputId})` : 'not run yet'}:`, '```sql', o.sql.trim(), '```')
      out.push('')
    }
  }
  out.push('# The visualizations', '')
  for (const v of l.visualizations) {
    const c = v.kind === 'scalar' ? v.style.color : v.style.color
    const color = c.kind === 'colormap' ? `colormap ${c.colormap}${c.reverse ? ' reversed' : ''}${c.scale === 'log' ? ', log scale' : ''}${c.domain ? `, domain ${c.domain.join('–')}` : ''}` : c.kind
    out.push(`- "${v.name}" (id ${v.id}): dataset "${name(v.datasetId)}" (${v.datasetId}), geometry ${v.binding.column}${v.binding.label ? `, named by ${v.binding.label}` : ''}, column ${v.column} (${v.aggregation}), ${color}`)
  }
  return out.join('\n')
}

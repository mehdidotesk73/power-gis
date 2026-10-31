// What of a workspace can't work on this device, and what to do about it.
// A dataset the workspace points at but the device doesn't have is a *missing
// root*; everything downstream of one waits on it — transforms reading it,
// the outputs they write (and so on down), visualizations drawing any of
// them. They're kept (saved along, drawn red) until the missing dataset is
// replaced (`replaceDataset`) or what didn't load is removed
// (`removeUnavailable`).

import { withoutEdit, type OpResult, type UnavailableDataset, type WorkspaceDoc } from './workspace'
import { remapStory } from '../story/story'

export interface Unavailability {
  /** Missing datasets nothing here can make: the ones to replace. */
  roots: string[]
  /** Every unavailable dataset → the missing roots it waits on (a root waits on itself). */
  datasets: Map<string, string[]>
  /** Transforms that can't run → the roots they wait on. */
  transforms: Map<string, string[]>
  /** Visualizations that can't draw → the roots they wait on. */
  visualizations: Map<string, string[]>
}

/**
 * Works out what can't work here. A missing dataset that a runnable transform
 * writes isn't a root: running the transform makes it.
 */
export function unavailability(doc: WorkspaceDoc, present: (id: string) => boolean): Unavailability {
  const writer = new Map<string, string>() // dataset id → transform id
  for (const t of doc.transforms) for (const o of t.outputs) if (o.outputId) writer.set(o.outputId, t.id)
  const all = new Set([...doc.datasetIds, ...doc.transforms.flatMap((t) => [...t.inputs.map((i) => i.datasetId), ...t.outputs.flatMap((o) => (o.outputId ? [o.outputId] : []))]), ...doc.visualizations.map((v) => v.datasetId)])
  const datasets = new Map<string, string[]>()
  const transforms = new Map<string, string[]>()
  // Roots: missing, and not written by a transform here.
  for (const id of all) if (!present(id) && !writer.has(id)) datasets.set(id, [id])
  // Downstream, to a fixed point: a transform waits on its inputs' roots; its missing outputs wait on the same.
  for (let grew = true; grew; ) {
    grew = false
    for (const t of doc.transforms) {
      const roots = [...new Set(t.inputs.flatMap((i) => datasets.get(i.datasetId) ?? []))]
      if (!roots.length || (transforms.get(t.id)?.length ?? 0) >= roots.length) continue
      transforms.set(t.id, roots)
      grew = true
      for (const o of t.outputs) if (o.outputId && !present(o.outputId)) datasets.set(o.outputId, roots)
    }
  }
  const visualizations = new Map<string, string[]>()
  for (const v of doc.visualizations) {
    const roots = datasets.get(v.datasetId)
    if (roots) visualizations.set(v.id, roots)
  }
  return { roots: [...all].filter((id) => !present(id) && !writer.has(id)), datasets, transforms, visualizations }
}

/** What's known of a dataset the workspace points at but this device doesn't have. */
export function unavailableInfo(doc: WorkspaceDoc, id: string): UnavailableDataset {
  const known = doc.unavailable?.[id]
  if (known) return known
  const output = doc.transforms.flatMap((t) => t.outputs).find((o) => o.outputId === id)
  return { name: output?.name ?? 'Unknown dataset', why: output ? 'output' : 'unknown' }
}

/**
 * The workspace with `newId` in place of `oldId` everywhere: its place in the
 * dataset list, transforms reading it (and an output writing it), and its
 * visualizations. What was known of the old one goes.
 */
export function replaceDataset(doc: WorkspaceDoc, oldId: string, newId: string): OpResult {
  if (oldId === newId) return { ok: true, doc }
  // The replacement can't be something made from the dataset it replaces (a transform would then read its own output).
  const downstream = new Set(downstreamOrder(doc, oldId).flatMap((id) => doc.transforms.find((t) => t.id === id)!.outputs.flatMap((o) => (o.outputId ? [o.outputId] : []))))
  if (downstream.has(newId)) return { ok: false, error: { code: 'invalid', message: "That dataset is made from the one it would replace; pick another (or a file)" } }
  const r = (id: string) => (id === oldId ? newId : id)
  const datasetIds = doc.datasetIds.includes(newId) ? doc.datasetIds.filter((d) => d !== oldId) : doc.datasetIds.map(r)
  const { [oldId]: _gone, ...unavailable } = doc.unavailable ?? {}
  return {
    ok: true,
    doc: {
      ...withoutEdit(doc, oldId),
      datasetIds,
      visualizations: doc.visualizations.map((v) => (v.datasetId === oldId ? { ...v, datasetId: newId } : v)),
      transforms: doc.transforms.map((t) => ({
        ...t,
        inputs: t.inputs.map((i) => ({ ...i, datasetId: r(i.datasetId) })),
        outputs: t.outputs.map((o) => (o.outputId === oldId ? { ...o, outputId: newId } : o)),
      })),
      ...(Object.keys(unavailable).length ? { unavailable } : { unavailable: undefined }),
      ...(doc.stories ? { stories: doc.stories.map((s) => remapStory(s, { dataset: (id) => (id === oldId ? newId : undefined) })) } : {}),
    },
  }
}

/**
 * The workspace without what didn't load: the missing roots and the datasets,
 * transforms and visualizations waiting on them. Runnable transforms whose
 * output isn't made yet stay (Run makes it).
 */
export function removeUnavailable(doc: WorkspaceDoc, present: (id: string) => boolean): OpResult {
  const u = unavailability(doc, present)
  return {
    ok: true,
    doc: {
      ...doc,
      datasetIds: doc.datasetIds.filter((id) => !u.datasets.has(id)),
      visualizations: doc.visualizations.filter((v) => !u.visualizations.has(v.id)),
      transforms: doc.transforms.filter((t) => !u.transforms.has(t.id)),
      unavailable: undefined,
    },
  }
}

/** The transforms downstream of a dataset, each after the ones writing its inputs (what "Run them now" runs after a replace). */
export function downstreamOrder(doc: WorkspaceDoc, datasetId: string): string[] {
  const readers = (ids: Set<string>) => doc.transforms.filter((t) => t.inputs.some((i) => ids.has(i.datasetId)))
  const reached = new Set<string>()
  let frontier = new Set([datasetId])
  while (frontier.size) {
    const next = new Set<string>()
    for (const t of readers(frontier)) {
      if (reached.has(t.id)) continue
      reached.add(t.id)
      for (const o of t.outputs) if (o.outputId) next.add(o.outputId)
    }
    frontier = next
  }
  // Inputs first: a transform after every reached transform writing one of its inputs.
  const writer = new Map<string, string>()
  for (const t of doc.transforms) for (const o of t.outputs) if (o.outputId) writer.set(o.outputId, t.id)
  const order: string[] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id) || !reached.has(id)) return
    seen.add(id)
    const t = doc.transforms.find((x) => x.id === id)!
    for (const i of t.inputs) {
      const w = writer.get(i.datasetId)
      if (w && w !== id) visit(w)
    }
    order.push(id)
  }
  for (const t of doc.transforms) visit(t.id)
  return order
}

/**
 * The workspace's datasets that exist only on this device: uploads kept here.
 * Built-ins (made anywhere) and transform outputs (re-run anywhere) aren't
 * among them, nor cloud datasets. Other devices, and anyone the workspace is
 * shared with, see these as missing.
 */
export function onlyOnThisDevice(
  doc: WorkspaceDoc,
  record: (id: string) => { id: string; name: string; link?: unknown; extensions?: Record<string, unknown> } | undefined,
): { id: string; name: string }[] {
  const written = new Set(doc.transforms.flatMap((t) => t.outputs.flatMap((o) => (o.outputId ? [o.outputId] : []))))
  return doc.datasetIds.flatMap((id) => {
    const d = record(id)
    if (!d || written.has(id) || d.link || typeof d.extensions?.builtin === 'string') return []
    return [{ id, name: d.name }]
  })
}

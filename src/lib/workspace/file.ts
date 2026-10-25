// Workspace files and drafts. Both carry the workspace's pointers and
// visualization settings — never dataset rows. A file opens wherever the
// database has the datasets it points at (this device today; any device
// once the database is shared).

import type { VisualizationSettings, VisualizationSpec } from '../dataset/visualization'
import { settingsOf } from '../dataset/visualization'
import { newId } from '../dataset/dataset'
import type { WorkspaceDoc } from './workspace'

export const FILE_FORMAT = 'powergis-workspace'
export const FILE_VERSION = 1

export interface WorkspaceFile {
  format: typeof FILE_FORMAT
  version: typeof FILE_VERSION
  exportedAt: string
  /** The workspace it was exported from (informational). */
  workspaceId?: string
  name: string
  datasetIds: string[]
  /** Top of the list first. */
  visualizations: { name: string; datasetId: string; settings: VisualizationSettings }[]
}

export function toWorkspaceFile(doc: WorkspaceDoc): WorkspaceFile {
  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    ...(doc.id ? { workspaceId: doc.id } : {}),
    name: doc.name,
    datasetIds: [...doc.datasetIds],
    visualizations: doc.visualizations.map((v) => ({ name: v.name, datasetId: v.datasetId, settings: settingsOf(v) })),
  }
}

export const fileName = (doc: WorkspaceDoc) => `${doc.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'workspace'}.powergis.json`

type Parsed = { ok: true; file: WorkspaceFile } | { ok: false; error: string }

/** Validates a workspace file's text; the error says what's wrong. */
export function parseWorkspaceFile(text: string): Parsed {
  let o: Partial<WorkspaceFile>
  try {
    o = JSON.parse(text)
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' }
  }
  if (!o || o.format !== FILE_FORMAT) return { ok: false, error: 'This is not a PowerGIS workspace file.' }
  if (o.version !== FILE_VERSION) return { ok: false, error: `Workspace file version ${o.version} isn't supported (expected ${FILE_VERSION}).` }
  if (typeof o.name !== 'string' || !Array.isArray(o.datasetIds) || !o.datasetIds.every((d) => typeof d === 'string') || !Array.isArray(o.visualizations)) {
    return { ok: false, error: 'The workspace file is incomplete or damaged.' }
  }
  for (const v of o.visualizations) {
    const s = v?.settings as Partial<VisualizationSettings> | undefined
    if (typeof v?.name !== 'string' || typeof v.datasetId !== 'string' || !s || (s.kind !== 'scalar' && s.kind !== 'vector') || !s.binding || typeof s.column !== 'string' || !s.style) {
      return { ok: false, error: 'A visualization in the file is incomplete or damaged.' }
    }
  }
  return { ok: true, file: o as WorkspaceFile }
}

/**
 * The working copy a file describes, keeping the current workspace's id (a
 * loaded file replaces its contents) and giving visualizations fresh ids so
 * they never collide with another workspace's records. Datasets missing from
 * the database are dropped, with their visualizations, and reported.
 */
export function fromWorkspaceFile(file: WorkspaceFile, current: WorkspaceDoc, inDatabase: (id: string) => boolean): { doc: WorkspaceDoc; missing: string[] } {
  const missing = file.datasetIds.filter((id) => !inDatabase(id))
  const datasetIds = file.datasetIds.filter((id) => inDatabase(id))
  const visualizations = file.visualizations
    .filter((v) => datasetIds.includes(v.datasetId))
    .map((v) => ({ ...v.settings, id: newId(), name: v.name, datasetId: v.datasetId }) as VisualizationSpec)
  return { doc: { ...(current.id ? { id: current.id } : {}), name: file.name, datasetIds, visualizations }, missing }
}

// ── drafts ─────────────────────────────────────────────────────────────────

/** Stable text of what Save would store — equal text means nothing to save. */
export function snapshot(doc: WorkspaceDoc): string {
  return JSON.stringify({ name: doc.name, datasetIds: doc.datasetIds, visualizations: doc.visualizations })
}

/** Unsaved edits kept on the device between visits. */
export interface Draft {
  doc: WorkspaceDoc
  /** Snapshot of the workspace as last saved (to tell whether the draft differs). */
  saved: string
}

export function parseDraft(text: string | null): Draft | null {
  if (!text) return null
  try {
    const d = JSON.parse(text) as Draft
    return d && typeof d.saved === 'string' && d.doc && Array.isArray(d.doc.datasetIds) && Array.isArray(d.doc.visualizations) ? d : null
  } catch {
    return null
  }
}

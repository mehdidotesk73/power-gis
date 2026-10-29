// What the server needs from the cloud (Supabase today), as an interface so
// the server stays testable without a network: the worker makes a real one
// for the signed-in user's token (server/cloud.ts), tests a fake.
import type { WorkspaceFile } from '../lib/workspace/file'
import type { ColumnInfo } from '../lib/dataset/columns'

export interface CloudWorkspace {
  id: string
  name: string
  /** The workspace document as stored (an older version possibly: parse it). */
  file: unknown
  updatedAt: string
}

export interface CloudStore {
  /** The user's default workspace, or null before their first save. */
  defaultWorkspace(): Promise<CloudWorkspace | null>
  /** Creates or replaces the user's default workspace. */
  saveDefaultWorkspace(w: { name: string; file: WorkspaceFile; overview: string }): Promise<{ id: string; updatedAt: string }>

  /** The cloud datasets the user can see, of these ids. */
  datasets(ids: string[]): Promise<CloudDataset[]>
  /** Creates the dataset (same id as here) or replaces its rows and details; answers its new version. */
  putDataset(d: CloudDatasetDetails, file: Uint8Array): Promise<{ updatedAt: string }>
  /** The dataset's rows file. */
  readFile(id: string): Promise<Uint8Array>
  /** Deletes the dataset and its file (owners only). */
  deleteDataset(id: string): Promise<void>

  /** Every cloud dataset the user can see (theirs and the ones shared with them). */
  listDatasets(): Promise<CloudDataset[]>
  /** Who has access to a dataset (the user too, marked `you`). */
  members(id: string): Promise<CloudMember[]>
  /** Gives the person with this email read or write access (or changes theirs); fails when no account uses it. */
  share(id: string, email: string, access: Exclude<Access, 'owner'>): Promise<void>
  /** Changes a member's access. */
  setAccess(id: string, userId: string, access: Exclude<Access, 'owner'>): Promise<void>
  /** Takes a member's access away (the user's own: leaving it). */
  removeAccess(id: string, userId: string): Promise<void>
}

export type Access = 'owner' | 'write' | 'read'

/** One person with access to a cloud dataset. */
export interface CloudMember {
  userId: string
  email: string
  name: string
  access: Access
  /** The signed-in user. */
  you?: boolean
}

/**
 * What a member with access `mine` may do to member `them` — the database's own rules
 * (supabase/schema.sql, the dataset_access policies), checked here first to say why not:
 * the owner changes and removes anyone else; writers share (read or write), raise readers to
 * write and remove readers; anyone but the owner can leave.
 */
export function canManage(mine: Access | undefined, them: CloudMember): { change: boolean; remove: boolean } {
  if (them.access === 'owner' || !mine) return { change: false, remove: false }
  if (them.you) return { change: false, remove: true }
  if (mine === 'owner') return { change: true, remove: true }
  if (mine === 'write' && them.access === 'read') return { change: true, remove: true }
  return { change: false, remove: false }
}
/** Whether a member with this access may share the dataset with someone new. */
export const canShare = (mine: Access | undefined) => mine === 'owner' || mine === 'write'

/** What the cloud keeps about a dataset besides its rows file. */
export interface CloudDatasetDetails {
  id: string
  name: string
  description: string
  columns: ColumnInfo[]
  rowCount: number
  /** Origin and extensions (the SQL that wrote an output, a built-in's table, …). */
  meta: { origin?: string; extensions?: Record<string, unknown> }
}
export interface CloudDataset extends CloudDatasetDetails {
  /** Its version: when it last changed (the database's updated_at). */
  updatedAt: string
  sizeBytes?: number
  /** Whether it has a rows file yet. */
  hasFile: boolean
  /** The signed-in user's access: owner and write may push, everyone with access may pull. */
  access: Access
}

/** A dataset's rows file in the cloud bucket: `<id>/data.arrow.gz` (server/datasetFile.ts). */
export const DATASET_FILE = { name: 'data.arrow.gz', contentType: 'application/gzip' }
export const cloudFilePath = (id: string) => `${id}/${DATASET_FILE.name}`

/** The largest rows file cloud storage takes (Supabase's free plan: 50 MB a file). */
export const MAX_CLOUD_FILE = 50 * 1024 * 1024

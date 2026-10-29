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
}

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
  access: 'owner' | 'write' | 'read'
}

/** A dataset's rows file in the cloud bucket: `<id>/data.arrow.gz` (server/datasetFile.ts). */
export const DATASET_FILE = { name: 'data.arrow.gz', contentType: 'application/gzip' }
export const cloudFilePath = (id: string) => `${id}/${DATASET_FILE.name}`

/** The largest rows file cloud storage takes (Supabase's free plan: 50 MB a file). */
export const MAX_CLOUD_FILE = 50 * 1024 * 1024

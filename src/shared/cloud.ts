// What the server needs from the cloud (Supabase today), as an interface so
// the server stays testable without a network: the worker makes a real one
// for the signed-in user's token (server/cloud.ts), tests a fake.
import type { WorkspaceFile } from '../lib/workspace/file'

export interface CloudWorkspace {
  id: string
  name: string
  /** A portable workspace file (template pointers for built-ins and transform outputs). */
  file: WorkspaceFile
  updatedAt: string
}

export interface CloudStore {
  /** The user's default workspace, or null before their first save. */
  defaultWorkspace(): Promise<CloudWorkspace | null>
  /** Creates or replaces the user's default workspace. */
  saveDefaultWorkspace(w: { name: string; file: WorkspaceFile }): Promise<{ id: string; updatedAt: string }>
}

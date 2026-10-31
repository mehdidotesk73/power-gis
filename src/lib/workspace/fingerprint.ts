// A workspace's fingerprint, and whether this device and the account agree.
//
// The fingerprint is a SHA-256 of the workspace's setup as a document: its
// name, dataset pointers, transforms, visualizations, stories and the datasets'
// names and descriptions. Not what changes on its own (row counts, stores, when it
// was exported), so the same setup always gives the same fingerprint.
//
// Each device remembers, per account, the account's fingerprint and its own at
// the last sync (an open from the account, or a send to it). Comparing both
// with now says who changed since: nobody (in sync), this device (↑), the
// account (↓, another device saved), or both (↑↓: the user chooses). The two
// are compared each with its own earlier value, never with each other: a
// device that opens the account's workspace makes its own ids for datasets it
// rebuilds, so the same setup can read differently on two devices.

import type { WorkspaceFile } from './file'

/** The setup a fingerprint covers, in a stable form (keys sorted at every level). */
export function setupOf(file: WorkspaceFile): unknown {
  return canonical({
    name: file.name,
    datasetIds: file.datasetIds,
    transforms: file.transforms,
    visualizations: file.visualizations,
    datasets: file.datasets.map((d) => ({ id: d.id, name: d.name, ...(d.description ? { description: d.description } : {}) })),
    ...(file.stories?.length ? { stories: file.stories } : {}),
  })
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
  )
}

/** The workspace's fingerprint (hex SHA-256 of its setup). */
export async function fingerprint(file: WorkspaceFile): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(setupOf(file)))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What a device remembers of its last sync with an account. */
export interface SyncPoint {
  user: string
  /** The account's fingerprint then. */
  cloud: string
  /** This device's (saved) fingerprint then. */
  local: string
}

/**
 * - `synced`: the same as at the last sync on both sides;
 * - `ahead` (↑): saved here since, the account unchanged: send it;
 * - `behind` (↓): the account changed since (another device saved), this device didn't: open it;
 * - `both` (↑↓): both changed: the user chooses which to keep;
 * - `new`: no sync yet on this device (the caller decides: an empty device opens the account's).
 */
export type WorkspaceSync = 'synced' | 'ahead' | 'behind' | 'both' | 'new'

export function workspaceSync(now: { cloud: string; local: string }, last: SyncPoint | null, user: string): WorkspaceSync {
  if (!last || last.user !== user) return now.cloud === now.local ? 'synced' : 'new'
  const cloudChanged = now.cloud !== last.cloud
  const localChanged = now.local !== last.local
  return cloudChanged ? (localChanged ? 'both' : 'behind') : localChanged ? 'ahead' : 'synced'
}

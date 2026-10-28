// The SQL engine's extensions PowerGIS may load: an allowlist, shared by the
// engine (which loads one when a query fails for want of it, then retries),
// the build (scripts/fetch-duckdb-extensions.mjs hosts the files with the
// app) and the agent's instructions. The data lives in sqlExtensions.json so
// the build script can read it without TypeScript.
//
// `conflictsWith` names extensions that can't share one engine. None do yet;
// when tabs arrive, a workspace that needs a conflicting one gets its own engine.

import data from './sqlExtensions.json'

export interface SqlExtension {
  name: string
  /** What it's for, in a sentence (shown to the agent). */
  purpose: string
  size: string
  /** Served from this app's own origin (downloaded at build time); else from DuckDB's repository. */
  hosted: boolean
  conflictsWith: string[]
}

/** The DuckDB build the app runs (extensions are built per version and platform; a test checks it). */
export const DUCKDB_VERSION: string = data.duckdbVersion
export const EXTENSION_PLATFORM: string = data.platform
export const SQL_EXTENSIONS: SqlExtension[] = data.extensions

export const sqlExtension = (name: string): SqlExtension | undefined => SQL_EXTENSIONS.find((x) => x.name === name)

/** Where an extension's file sits under a repository root (DuckDB's layout). */
export const extensionPath = (name: string) => `${DUCKDB_VERSION}/${EXTENSION_PLATFORM}/${name}.duckdb_extension.wasm`

/** The first loaded extension that can't share an engine with `name`, if any. */
export function conflictOf(name: string, loaded: Iterable<string>): string | undefined {
  const x = sqlExtension(name)
  for (const l of loaded) if (x?.conflictsWith.includes(l) || sqlExtension(l)?.conflictsWith.includes(name)) return l
  return undefined
}

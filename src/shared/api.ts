// The client ↔ server contract. The client changes anything lasting, or asks
// for anything heavy, only through these requests; the server writes the
// database and answers with pointers (ids) or small results. Everything
// here is structured-cloneable (a Web Worker today, JSON over HTTP later —
// except `File`, which becomes a multipart upload).

import type { DataRecord } from '../lib/data/connectors'
import type { Aggregation } from '../lib/dataset/aggregate'
import type { GeometryBinding } from '../lib/dataset/binding'
import type { BindingInfo, FindEntry, VizValues } from '../lib/dataset/query'
import type { VisualizationSettings } from '../lib/dataset/visualization'
import type { DatasetStore, TransformInputRef, TransformOutputRef, WorkspaceConfig } from './records'
import type { ColumnInfo } from '../lib/dataset/columns'
import type { DatasetProfile } from '../lib/dataset/profile'
import type { MissingDataset, WorkspaceFile } from '../lib/workspace/file'

export interface ApiError {
  code: 'not_found' | 'invalid' | 'failed' | 'unsupported'
  message: string
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }

/** A file or source to turn into a new dataset. */
export type UploadSource =
  | { kind: 'csv'; file: File }
  | { kind: 'json'; file: File } // GeoJSON or Esri JSON
  | { kind: 'arcgis'; url: string }
  | { kind: 'builtin'; table: string }

/** A transform as the client holds it (saved with the workspace; runnable any time). */
export interface TransformInput {
  id: string
  name: string
  inputs: TransformInputRef[]
  /** Each written on Run: into its `outputId`, or a new dataset (whose id it then gets). */
  outputs: TransformOutputRef[]
  /** SQL engine extensions its SQL uses (recorded from its last successful run). */
  requires?: string[]
}

export interface VisualizationInput {
  id: string
  name: string
  datasetId: string
  settings: VisualizationSettings
}

/** Request type → [payload, response]. */
export interface Api {
  /** Ensures the default user exists; tells the server where static files live. */
  init: [{ baseUrl: string }, { userId: string }]
  /** Upload a table: stored as a new data table, registered in `datasets`. */
  uploadDataset: [{ source: UploadSource; name?: string }, { datasetId: string }]
  updateDataset: [{ id: string; name?: string; description?: string; extensions?: Record<string, unknown> }, { datasetId: string }]
  /** Drops the data table and registry row, and every visualization of it. */
  deleteDataset: [{ id: string }, { datasetId: string }]
  /** Moves a dataset's rows to the other store, keeping its id (remote storage isn't available yet). */
  moveDataset: [{ id: string; to: DatasetStore }, { datasetId: string; store: DatasetStore }]
  /** How a dataset looks under a binding (features, unmatched rows, defaults). */
  describeBinding: [{ datasetId: string; binding: GeometryBinding }, BindingInfo]
  /** One value per feature for a visualization. */
  queryVisualization: [{ datasetId: string; binding: GeometryBinding; column: string; aggregation: Aggregation }, VizValues]
  /** Runs a transform's SQL without storing anything: the first rows, the columns and the full count. */
  previewTransform: [{ sql: string; inputs: TransformInputRef[]; limit?: number; offset?: number }, { columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number; extensions: string[] }]
  /** Runs every output's SQL, then (only if all succeed) stores each: into its `outputId`'s table, or a new dataset. Returns the pointers. */
  runTransform: [{ transform: TransformInput }, { outputs: { key: string; datasetId: string; rowCount: number; created: boolean }[]; requires: string[] }]
  /** Loads SQL engine extensions ahead of need (a workspace's transforms use them); answers what's loaded and from where. */
  loadSqlExtensions: [{ names: string[] }, { loaded: { name: string; from: string }[] }]
  /** A page of a dataset's rows (first rows by default), with its columns and the full count. */
  datasetRows: [{ datasetId: string; limit?: number; offset?: number }, { columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number }]
  /** A visualization's features (one per feature, its value) as a file to download. */
  exportVisualization: [
    { visualization: { id: string; name: string; datasetId: string; binding: GeometryBinding; column: string; aggregation: Aggregation }; format: 'geojson' | 'agol' | 'esri' | 'csv' },
    { fileName: string; mimeType: string; text: string },
  ]
  /** The default map as a workspace file with real dataset ids (built-ins uploaded or reused, transforms run or reused). */
  seedDefaultWorkspace: [Record<string, never>, { file: WorkspaceFile }]
  /**
   * A workspace document (any version) opened on this device: its dataset ids made real here — datasets
   * present used, built-ins uploaded or reused, transform outputs reused or made by running the
   * transforms. `missing`: datasets that couldn't be, with why; `failed`: transforms that couldn't run, with why.
   */
  openDocument: [{ file: unknown }, { file: WorkspaceFile; missing: MissingDataset[]; failed: { name: string; reason: string }[] }]
  /** The signed-in user's session for the cloud (null: signed out). The client sends it again whenever it changes. */
  setAuth: [{ accessToken: string | null }, { signedIn: boolean }]
  /** The signed-in user's default workspace in the cloud (a document, possibly an older version: open it with openDocument), or null before their first cloud save. */
  cloudWorkspace: [Record<string, never>, { workspace: { name: string; updatedAt: string; file: unknown } | null }]
  /** Stores a workspace document as the signed-in user's default cloud workspace, with its readable overview. */
  saveCloudWorkspace: [{ file: WorkspaceFile; overview: string }, { updatedAt: string }]
  /** A dataset's profile (computed and stored if the record has none yet). */
  profileDataset: [{ datasetId: string }, DatasetProfile]
  /** Every searchable value of a visualization's features: their names and the text in their rows. */
  findIndex: [{ datasetId: string; binding: GeometryBinding }, { entries: FindEntry[] }]
  /** The features that have a value (from `findIndex`). */
  findFeatures: [{ datasetId: string; binding: GeometryBinding; column: string; value: string }, { keys: string[] }]
  /** The rows behind one feature (click panel). */
  featureRows: [{ datasetId: string; binding: GeometryBinding; key: string }, DataRecord[]]
  /** Creates or updates a workspace with its visualizations and transforms; ones it no longer lists are deleted (output datasets stay). */
  saveWorkspace: [
    { id?: string; name: string; config: Pick<WorkspaceConfig, 'datasetIds' | 'unavailable'>; visualizations: VisualizationInput[]; transforms?: TransformInput[] },
    { workspaceId: string },
  ]
  deleteWorkspace: [{ id: string }, { workspaceId: string }]
}
export type RequestType = keyof Api
export type Payload<K extends RequestType> = Api[K][0]
export type Response<K extends RequestType> = Api[K][1]

/**
 * Who sent a request. Agent requests may read anything but change only local
 * datasets: the server refuses their writes to remote ones (docs/agents.md).
 */
export type Caller = 'user' | 'agent'

/** Wire messages between client and worker. */
export interface RequestMessage<K extends RequestType = RequestType> {
  id: number
  type: K
  payload: Payload<K>
  caller?: Caller
}
export interface ResponseMessage {
  id: number
  result: ApiResult<unknown>
}

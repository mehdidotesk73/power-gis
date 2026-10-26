// The client ↔ server contract. The client changes anything lasting, or asks
// for anything heavy, only through these requests; the server writes the
// database and answers with pointers (ids) or small results. Everything
// here is structured-cloneable (a Web Worker today, JSON over HTTP later —
// except `File`, which becomes a multipart upload).

import type { DataRecord } from '../lib/data/connectors'
import type { Aggregation } from '../lib/dataset/aggregate'
import type { GeometryBinding } from '../lib/dataset/binding'
import type { BindingInfo, VizValues } from '../lib/dataset/query'
import type { VisualizationSettings } from '../lib/dataset/visualization'
import type { TransformInputRef, WorkspaceConfig } from './records'
import type { ColumnInfo } from '../lib/dataset/columns'
import type { DatasetProfile } from '../lib/dataset/profile'

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
  sql: string
  inputs: TransformInputRef[]
  /** The dataset its last run wrote; absent → the next run makes a new one. */
  outputId?: string
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
  /** How a dataset looks under a binding (features, unmatched rows, defaults). */
  describeBinding: [{ datasetId: string; binding: GeometryBinding }, BindingInfo]
  /** One value per feature for a visualization. */
  queryVisualization: [{ datasetId: string; binding: GeometryBinding; column: string; aggregation: Aggregation }, VizValues]
  /** Runs a transform's SQL without storing anything: the first rows, the columns and the full count. */
  previewTransform: [{ sql: string; inputs: TransformInputRef[]; limit?: number }, { columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number }]
  /** Runs a transform and stores the result: into `outputId`'s table, or a new dataset. Returns the output pointer. */
  runTransform: [{ transform: TransformInput }, { datasetId: string; rowCount: number; created: boolean }]
  /** A dataset's profile (computed and stored if the record has none yet). */
  profileDataset: [{ datasetId: string }, DatasetProfile]
  /** The rows behind one feature (click panel). */
  featureRows: [{ datasetId: string; binding: GeometryBinding; key: string }, DataRecord[]]
  /** Creates or updates a workspace with its visualizations and transforms; ones it no longer lists are deleted (output datasets stay). */
  saveWorkspace: [
    { id?: string; name: string; config: Pick<WorkspaceConfig, 'datasetIds'>; visualizations: VisualizationInput[]; transforms?: TransformInput[] },
    { workspaceId: string },
  ]
  deleteWorkspace: [{ id: string }, { workspaceId: string }]
}
export type RequestType = keyof Api
export type Payload<K extends RequestType> = Api[K][0]
export type Response<K extends RequestType> = Api[K][1]

/** Wire messages between client and worker. */
export interface RequestMessage<K extends RequestType = RequestType> {
  id: number
  type: K
  payload: Payload<K>
}
export interface ResponseMessage {
  id: number
  result: ApiResult<unknown>
}

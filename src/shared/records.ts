// The database's base tables, shared by client (reads) and server (writes).
// Every record has a uuid `id` and an editable `name`. Each dataset's rows
// live in their own data table, named by `DatasetRecord.table`.
//
// No access control yet: every table is readable and writable by everyone.
// An access layer between users and these tables comes later.

import type { ColumnInfo } from '../lib/dataset/columns'
import type { DatasetProfile } from '../lib/dataset/profile'
import type { VisualizationSettings } from '../lib/dataset/visualization'

export interface BaseRecord {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export type UserRecord = BaseRecord

/** Pointers (ids) and their order — never rows. */
export interface WorkspaceConfig {
  datasetIds: string[]
  /** Top of the list draws on top. */
  visualizationIds: string[]
  transformIds?: string[]
}
export interface WorkspaceRecord extends BaseRecord {
  ownerId: string
  config: WorkspaceConfig
}

/**
 * Where a dataset's rows are kept: `local` on this device (IndexedDB), as many
 * as the device holds; `remote` in the shared database (later), within its
 * storage limit. Same functions either way. Agents may change only local ones.
 */
export type DatasetStore = 'local' | 'remote'

/**
 * The dataset registry: what a data table holds. Standard metadata only.
 * `updatedAt` is when the rows were last written: renaming or describing a
 * dataset leaves it alone, so transforms reading it don't turn stale.
 */
export interface DatasetRecord extends BaseRecord {
  /** Name of the data table holding the rows. */
  table: string
  columns: ColumnInfo[]
  rowCount: number
  /** Where the rows came from, for display ("Device · plants.csv"). */
  origin: string
  /** Where the rows are kept; records from before stores existed are local. */
  store?: DatasetStore
  description?: string
  /** What's in each column; computed whenever the data table is written. */
  profile?: DatasetProfile
  /** Open slot for features to attach their own metadata (e.g. `builtin`, the table a built-in copy came from). */
  extensions?: Record<string, unknown>
}

/** An input of a transform: a dataset, and the table name the SQL calls it by. */
export interface TransformInputRef {
  datasetId: string
  alias: string
}

/** One of a transform's outputs: a SELECT over the inputs, written to `outputId` (or a new dataset named `name`). */
export interface TransformOutputRef {
  /** Stable within the transform (UI keys, run results). */
  key: string
  name: string
  sql: string
  outputId?: string
}

/** Inputs and outputs; every output is written on each Run. (Older records had one `sql` + `outputId`.) */
export interface TransformRecord extends BaseRecord {
  inputs: TransformInputRef[]
  outputs: TransformOutputRef[]
}

/** A dataset pointer plus visualization settings (binding, column, aggregation, style). */
export interface VisualizationRecord extends BaseRecord {
  datasetId: string
  settings: VisualizationSettings
}

export interface Tables {
  users: UserRecord
  workspaces: WorkspaceRecord
  datasets: DatasetRecord
  transforms: TransformRecord
  visualizations: VisualizationRecord
}
export type TableName = keyof Tables
export const TABLES: TableName[] = ['users', 'workspaces', 'datasets', 'transforms', 'visualizations']

export const storeOf = (d: Pick<DatasetRecord, 'store'>): DatasetStore => d.store ?? 'local'

export const dataTableName = (datasetId: string) => `ds_${datasetId.replace(/-/g, '')}`

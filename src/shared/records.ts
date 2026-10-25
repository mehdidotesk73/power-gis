// The database's base tables, shared by client (reads) and server (writes).
// Every record has a uuid `id` and an editable `name`. Each dataset's rows
// live in their own data table, named by `DatasetRecord.table`.
//
// No access control yet: every table is readable and writable by everyone.
// An access layer between users and these tables comes later.

import type { ColumnInfo } from '../lib/dataset/columns'
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
}
export interface WorkspaceRecord extends BaseRecord {
  ownerId: string
  config: WorkspaceConfig
}

/** The dataset registry: what a data table holds. Standard metadata only. */
export interface DatasetRecord extends BaseRecord {
  /** Name of the data table holding the rows. */
  table: string
  columns: ColumnInfo[]
  rowCount: number
  /** Where the rows came from, for display ("Device · plants.csv"). */
  origin: string
  description?: string
  /** Open slot for features to attach their own metadata (e.g. `preset`). */
  extensions?: Record<string, unknown>
}

/** A SQL script over input datasets; a missing output id means "make a new dataset". */
export interface TransformRecord extends BaseRecord {
  sql: string
  inputIds: string[]
  outputId?: string
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

export const dataTableName = (datasetId: string) => `ds_${datasetId.replace(/-/g, '')}`

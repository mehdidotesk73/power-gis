// What the tools act through (the page supplies it), and the limits they share.

import type { ApiResult } from '../../shared/api'
import { type DatasetRecord, type TransformInputRef } from '../../shared/records'
import type { ColumnInfo } from '../../lib/dataset/columns'
import type { DataRecord } from '../../lib/data/connectors'
import { type Aggregation } from '../../lib/dataset/aggregate'
import type { GeometryBinding } from '../../lib/dataset/binding'
import type { BindingInfo, VizValues } from '../../lib/dataset/query'
import { type DatasetEdit, type WorkspaceDoc } from '../../lib/workspace/workspace'
import { type Card, type CardAnswer } from '../../lib/agent/form'
import { type Rounds } from '../../lib/agent/exchanges'

/** What the tools act through: the page's workspace copy and the server. */
export interface AgentHost {
  doc(): WorkspaceDoc
  setDoc(doc: WorkspaceDoc): void
  dataset(id: string): Promise<DatasetRecord | undefined>
  /** A workspace dataset's record as the page shows it (drafted name / description on top), if it's here. */
  record(id: string): DatasetRecord | undefined
  /** Every dataset the user can use, local and remote (the app's dataset finder). */
  listDatasets(): Promise<DatasetRecord[]>
  query(sql: string, inputs: TransformInputRef[], limit: number): Promise<ApiResult<{ columns: ColumnInfo[]; rows: DataRecord[]; rowCount: number }>>
  /** How a dataset looks under a geometry binding, or an error message. */
  shape(datasetId: string, binding: GeometryBinding): Promise<BindingInfo | string>
  /** The values a visualization draws, one per feature (what the map colors), or an error message. */
  values(datasetId: string, binding: GeometryBinding, column: string, aggregation: Aggregation): Promise<VizValues | string>
  runTransform(id: string): Promise<{ ok: true; outputs: { datasetId: string; name: string; rowCount: number; created: boolean }[] } | { ok: false; message: string }>
  deleteDataset(id: string): Promise<{ ok: true } | { ok: false; message: string }>
  /** Drafts a dataset's new name / description (written to it when the user saves). */
  updateDataset(id: string, patch: DatasetEdit): { ok: true } | { ok: false; message: string }
  /** Shows the user a question card (details, fields, buttons); resolves with their answer. */
  ask(card: Card): Promise<CardAnswer>
  /** The exchanges' revision rounds, kept for the chat (exchanges.ts). */
  rounds?: Rounds
  /** Adds a file (a scraper's CSV or GeoJSON) as a new dataset in the workspace, with a description. */
  importCsv?(file: File, description: string): Promise<{ ok: true; id: string } | { ok: false; message: string }>
  /** Sends the scout or the scraper with a brief and a spending cap, and follows it to the end (the chat shows its progress); a message when it can't. */
  web?(role: WebRole, brief: string, capDollars: number): Promise<WebRun | string>
  /** Whether the user is signed in to PowerGIS (the scout and scraper need it; the chat doesn't). */
  signedIn?(): boolean
  /** Shows the user a way to sign in (the chat's Sign in button). */
  askSignIn?(): void
  /** Follows a run started earlier (by its session id) to its end, or reads it if it has ended; its result, or why not. */
  fetchRun?(sessionId: string): Promise<(WebRun & { role: WebRole; brief: string }) | string>
  /** Reads a run back by its id, changing nothing: its status, cost, events (condensed), last message and files, as text; or why not. */
  readRun?(sessionId: string): Promise<{ text: string; status: string; files: string[] } | string>
  /** Runs started on this device lately: id, role, brief, when, how it ended. */
  runs?(): { sessionId: string; role: WebRole; brief: string; startedAt: number; state: string; error?: string; cost?: number; files?: string[] }[]
  /** Runs the diagnosis agent (the user approves it and picks its model first); its report, or why not. */
  diagnose?(what: string): Promise<{ report: string; model: string; cost?: number } | string>
  /** Imports one of a web run's output files (a CSV or GeoJSON) as a new dataset; its id, or a message. */
  importWebFile?(fileId: string, name: string, description: string): Promise<{ ok: true; id: string } | { ok: false; message: string }>
  /** The tables that ship with the app (state and county boundaries…), whether or not they're stored on this device yet. */
  builtins?(): { table: string; label: string; description: string }[]
  /** Adds a built-in table to the workspace (stored on this device first if it isn't yet); its dataset id. */
  addBuiltin?(table: string): Promise<{ ok: true; id: string } | { ok: false; message: string }>
  /** Runs the storyteller on some visualizations (a new story, or `storyId` rewritten); what it wrote, or why it couldn't. */
  tellStory?(req: { visualizationIds: string[]; wishes: string; storyId?: string }): Promise<{ storyId: string; name: string; scenes: string[] } | string>
}

export type WebRole = 'scout' | 'scraper'

export interface WebRun {
  sessionId: string
  report: string
  files: { id: string; name: string; bytes: number }[]
  /** Files the run said it saved that never came back. */
  missing?: string[]
  cost?: number
  elapsedSeconds: number
  /** Why it stopped: end_turn when it finished; stopped, budget_reached, terminated… otherwise. */
  stop: string
}

/** The spending caps the approval card offers, in dollars. */
export const WEB_CAPS = [0.5, 1, 2, 5]

/** Caps a run may have, in dollars. */
export const CAP_RANGE = { min: 0.1, max: 25 }

export const QUERY_LIMIT = 50

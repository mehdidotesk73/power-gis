// What the agent loop needs from an AI provider, independent of whose model
// it is. An adapter (client/agent/claude.ts for Anthropic) keeps the
// provider's own conversation history — thinking blocks, server-tool blocks —
// and hands the loop plain text and tool calls.

/** A tool the model may call: JSON Schema input, run by our code. */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /**
   * A tool the provider defines and the model is trained on: `text_editor` is Anthropic's text
   * editor (view / create / str_replace / insert). We still run it; other providers get it as an
   * ordinary tool with `inputSchema`.
   */
  builtin?: 'text_editor'
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ToolResult {
  id: string
  content: string
  isError?: boolean
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * How a turn ended: `tools` = run the calls and send the results;
 * `done` = the model is waiting for the user; `refused` / `truncated` = stop.
 */
export type TurnStop = 'done' | 'tools' | 'refused' | 'truncated'

export interface TurnResult {
  text: string
  toolCalls: ToolCall[]
  stop: TurnStop
  usage: Usage
}

export interface TurnEvents {
  /** Streamed text, as it arrives. */
  onText?(delta: string): void
  /** The model's reasoning (a summary of it), as it arrives. */
  onThinking?(delta: string): void
  /** The connection dropped and the step is being sent again (attempt n of max), after `waitMs`; `null` once it went through. */
  onRetry?(r: { attempt: number; max: number; waitMs: number; reason: string } | null): void
}

/** An image the user attached (base64, already resized for the model). */
export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
}

/** What the user sends: text, and optionally images (screenshots). */
export interface UserMessage {
  text: string
  images?: ImageInput[]
}

export type TurnInput = UserMessage | { toolResults: ToolResult[] }

export interface ChatSession {
  /** Sends the user's message (or the results of the last turn's tool calls); resolves with the model's next turn. */
  send(input: TurnInput, events: TurnEvents, signal?: AbortSignal): Promise<TurnResult>
  /** Changes the model for the calls from now on (the history stays as it is: a model that can't read earlier reasoning just goes without it). */
  setModel?(model: string): void
}

export interface ChatProvider {
  id: string
  label: string
  /** A session on a model (changeable between calls: setModel). */
  start(opts: { apiKey: string; model: string; system: string; tools: ToolSpec[] }): ChatSession
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

// What the agent loop needs from an AI provider, independent of whose model
// it is. An adapter (client/agent/claude.ts for Anthropic) keeps the
// provider's own conversation history — thinking blocks, server-tool blocks —
// and hands the loop plain text and tool calls.

/** A tool the model may call: JSON Schema input, run by our code. */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
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
}

export type TurnInput = { text: string } | { toolResults: ToolResult[] }

export interface ChatSession {
  /** Sends the user's message (or the results of the last turn's tool calls); resolves with the model's next turn. */
  send(input: TurnInput, events: TurnEvents, signal?: AbortSignal): Promise<TurnResult>
}

export interface ChatProvider {
  id: string
  label: string
  start(opts: { apiKey: string; system: string; tools: ToolSpec[] }): ChatSession
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

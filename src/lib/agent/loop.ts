// The agent loop, provider-neutral: send the user's message, run the tools the
// model asks for, send their results back, until the model answers in text
// (or stops for another reason). Tool calls never throw: every outcome,
// including a refusal from the gate, goes back to the model to act on.

import { addUsage, emptyUsage, type ChatSession, type ToolCall, type ToolResult, type TurnStop, type Usage, type UserMessage } from './provider'

export interface ToolOutcome {
  content: string
  isError: boolean
  /** One line for the chat ("3,142 rows", "refused: remote dataset"). */
  summary: string
}

export interface LoopEvents {
  onText?(delta: string): void
  /** A new assistant message starts (after tool results, the model writes again). */
  onTurnStart?(): void
  onToolStart?(call: ToolCall): void
  onToolEnd?(call: ToolCall, outcome: ToolOutcome): void
}

export type LoopEnd = TurnStop | 'step-limit' | 'stopped'

/** Model turns per user message before the loop stops and reports. */
export const MAX_STEPS = 40

export async function runAgent(
  session: ChatSession,
  runTool: (name: string, input: unknown) => Promise<ToolOutcome>,
  message: string | UserMessage,
  events: LoopEvents = {},
  signal?: AbortSignal,
): Promise<{ end: LoopEnd; usage: Usage }> {
  let usage = emptyUsage()
  let input: Parameters<ChatSession['send']>[0] = typeof message === 'string' ? { text: message } : message
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return { end: 'stopped', usage }
    events.onTurnStart?.()
    const turn = await session.send(input, { onText: events.onText }, signal)
    usage = addUsage(usage, turn.usage)
    if (turn.stop !== 'tools') return { end: turn.stop, usage }
    const results: ToolResult[] = []
    for (const call of turn.toolCalls) {
      if (signal?.aborted) {
        results.push({ id: call.id, content: 'Stopped by the user before this ran.', isError: true })
        continue
      }
      events.onToolStart?.(call)
      const out = await runTool(call.name, call.input)
      events.onToolEnd?.(call, out)
      results.push({ id: call.id, content: out.content, isError: out.isError })
    }
    input = { toolResults: results }
  }
  return { end: 'step-limit', usage }
}

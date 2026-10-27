// The Anthropic (Claude) adapter for the agent loop. Calls the Messages API
// straight from the browser with the user's own API key (kept on this
// device), streaming. It keeps the conversation in Anthropic's own format —
// thinking, fallback and server-tool blocks go back unchanged — and gives the
// loop plain text and tool calls (lib/agent/provider.ts).

import Anthropic from '@anthropic-ai/sdk'
import { emptyUsage, addUsage, type ChatProvider, type ChatSession, type ToolCall, type ToolSpec, type TurnEvents, type TurnInput, type TurnResult, type Usage } from '../../lib/agent/provider'

export const CLAUDE_MODEL = 'claude-opus-5-5'

/** The models offered in the assistant's settings; prices are $ per million tokens in / out. */
export const CLAUDE_MODELS: { id: string; label: string; note: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'recommended · $4 / $20' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'most capable · $10 / $50' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'balanced · $2 / $10' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'fastest, cheapest · $0.10 / $0.50' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'previous Opus · $5 / $25' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'previous Sonnet · $2 / $10' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', note: 'older' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', note: 'older' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'older' },
]
/** Models whose declined requests Anthropic can retry on its recommended fallback model (server side). */
const SERVER_FALLBACK = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const MAX_TOKENS = 32000
/** Long server-side work can pause a turn; resume it this many times at most. */
const MAX_RESUMES = 5

type Msg = Anthropic.Beta.BetaMessageParam
type Block = Anthropic.Beta.BetaContentBlockParam

const usageOf = (u: Anthropic.Beta.BetaUsage): Usage => ({
  input: u.input_tokens ?? 0,
  output: u.output_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
})

class ClaudeSession implements ChatSession {
  private history: Msg[] = []
  private readonly tools: Anthropic.Beta.BetaToolUnion[]

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly system: string,
    tools: ToolSpec[],
  ) {
    // Streamed tool inputs arrive as generated (eager); lib/agent/tools.ts validates every input before running it.
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    }))
  }

  async send(input: TurnInput, events: TurnEvents, signal?: AbortSignal): Promise<TurnResult> {
    this.history.push(this.userMessage(input))
    let usage = emptyUsage()
    let text = ''
    let jsonRetries = 0
    let resumes = 0
    for (;;) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: this.system,
          tools: this.tools,
          messages: this.history,
          cache_control: { type: 'ephemeral' },
          ...(SERVER_FALLBACK.has(this.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal },
      )
      let turnText = ''
      stream.on('text', (delta) => {
        turnText += delta
        events.onText?.(delta)
      })
      let msg: Anthropic.Beta.BetaMessage
      try {
        msg = await stream.finalMessage()
      } catch (e) {
        // API errors (auth, rate limit, the user's Stop) go to the caller; a tool
        // input that couldn't be parsed at all is retried a couple of times.
        if (e instanceof Anthropic.APIError || jsonRetries++ >= 2) throw e
        continue
      }
      usage = addUsage(usage, usageOf(msg.usage))
      text += turnText
      if (msg.stop_reason === 'refusal') return { text, toolCalls: [], stop: 'refused', usage }
      this.history.push({ role: 'assistant', content: msg.content as Block[] })
      if (msg.stop_reason === 'pause_turn' && resumes++ < MAX_RESUMES) continue
      const toolCalls: ToolCall[] = msg.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []))
      if (toolCalls.length && msg.stop_reason === 'max_tokens') {
        // A tool input cut off mid-way can still look valid: never run it.
        this.history.pop()
        return { text, toolCalls: [], stop: 'truncated', usage }
      }
      return { text, toolCalls, stop: toolCalls.length ? 'tools' : msg.stop_reason === 'max_tokens' ? 'truncated' : 'done', usage }
    }
  }

  private userMessage(input: TurnInput): Msg {
    if ('toolResults' in input) {
      return {
        role: 'user',
        content: input.toolResults.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      }
    }
    // Tool calls left unanswered (the user stopped the loop) need results before new text.
    const last = this.history.at(-1)
    const pending = last?.role === 'assistant' && Array.isArray(last.content) ? last.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])) : []
    return {
      role: 'user',
      content: [
        ...pending.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'Not run: the user stopped the work.', is_error: true })),
        { type: 'text' as const, text: input.text },
      ],
    }
  }
}

/** A session over the given transport (`fetchImpl` stands in for the network in tests). */
export function startClaude(opts: { apiKey: string; model?: string; system: string; tools: ToolSpec[] }, fetchImpl?: typeof fetch): ChatSession {
  // The key is the user's own, entered on this device; calls go straight to Anthropic.
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
  return new ClaudeSession(client, opts.model ?? CLAUDE_MODEL, opts.system, opts.tools)
}

export const claudeProvider: ChatProvider = {
  id: 'anthropic',
  label: 'Claude (Anthropic API)',
  start: (opts) => startClaude(opts),
}

/** A readable message for an API failure. */
export function describeError(e: unknown): string {
  if (e instanceof Anthropic.APIUserAbortError) return 'Stopped.'
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was not accepted. Check it in the assistant settings.'
  if (e instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use the model. Check your Anthropic Console workspace."
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by Anthropic. Wait a moment and try again.'
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check the connection and try again."
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ''}: ${e.message}`
  return (e as Error)?.message ?? String(e)
}

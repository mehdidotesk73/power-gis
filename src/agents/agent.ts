// What defines an agent: its prompt (prompt.md next to its config), its tools, where it runs, and which of the
// profile's models it takes (chosen when it is called, never fixed here). The tool handlers live in ./tools; the
// plumbing that calls a model lives in client/agent (claude.ts in the browser, managed.ts / provision.ts for Managed
// Agents) and lib/agent/loop.ts.

import type { ToolSpec } from '../lib/agent/provider'

/** A profile's model slot (lib/agent/profiles.ts), or one the user picks when it runs. */
export type ModelSlot = 'assistant' | 'scout' | 'scraper' | 'reviewer' | 'storyteller' | 'chosen'

interface Common {
  name: string
  /** What it does, in a line. */
  role: string
  model: ModelSlot
  prompt: string
}
/** Called from this page with the user's key (client/agent/claude.ts + lib/agent/loop.ts); its tools' handlers are in ./tools. */
export interface BrowserAgent extends Common {
  runs: 'browser'
  tools: ToolSpec[]
}
/** An Anthropic Managed Agent on the user's account, reached through the relay (client/agent/managed.ts, provision.ts). */
export interface ManagedAgent extends Common {
  runs: 'managed'
  /** Anthropic's built-in toolset config (runs in the agent's own sandbox). */
  tools: object[]
}
export type AgentConfig = BrowserAgent | ManagedAgent

/** A prompt.md with its {{NAME}} slots filled in: every slot must be given, and every value used. */
export function fill(template: string, values: Record<string, string | number> = {}): string {
  const text = template.replace(/\n$/, '')
  const seen = new Set<string>()
  const out = text.replace(/\{\{([A-Z_]+)\}\}/g, (_, name: string) => {
    if (!(name in values)) throw new Error(`prompt slot {{${name}}} has no value`)
    seen.add(name)
    return String(values[name])
  })
  const unused = Object.keys(values).filter((k) => !seen.has(k))
  if (unused.length) throw new Error(`prompt has no slot for ${unused.join(', ')}`)
  return out
}

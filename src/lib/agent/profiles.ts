// Profiles: which model does each job. The user picks a profile, not a model —
// the assistant (the chat), the scout (looks for data on the web), the scraper
// (fetches it) and the reviewer (checks the finished work; not built yet) each get
// the model that suits the profile. Scrapers mostly follow instructions, so most
// profiles keep them on Haiku; scouting and reviewing are where judgement pays.
// A chat keeps the profile it started with.
//
// Each finished chat turn also updates the chat's line in a small log on this
// device (cost, tokens, scout / scraper runs), so a profile's average cost per
// chat can be shown next to it. The cloud table of runs comes with run records.

export type AgentRole = 'assistant' | 'scout' | 'scraper' | 'reviewer'

export interface AgentProfile {
  id: string
  label: string
  /** One line on what it's for. */
  note: string
  models: Record<AgentRole, string>
}

const HAIKU = 'claude-haiku-5-5'
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

export const PROFILES: AgentProfile[] = [
  { id: 'quick', label: 'Quick', note: 'everything on Haiku · cheapest', models: { assistant: HAIKU, scout: HAIKU, scraper: HAIKU, reviewer: HAIKU } },
  { id: 'smart-scout', label: 'Smart scout', note: 'Haiku, with Sonnet scouting and reviewing', models: { assistant: HAIKU, scout: SONNET, scraper: HAIKU, reviewer: SONNET } },
  { id: 'balanced', label: 'Balanced', note: 'Sonnet, with a Haiku scraper', models: { assistant: SONNET, scout: SONNET, scraper: HAIKU, reviewer: SONNET } },
  { id: 'deep-research', label: 'Deep research', note: 'Sonnet, with Opus scouting and reviewing', models: { assistant: SONNET, scout: OPUS, scraper: HAIKU, reviewer: OPUS } },
  { id: 'planner', label: 'Planner', note: 'Opus plans and reviews; Sonnet scouts', models: { assistant: OPUS, scout: SONNET, scraper: HAIKU, reviewer: OPUS } },
  { id: 'all-sonnet', label: 'All Sonnet', note: 'everything on Sonnet', models: { assistant: SONNET, scout: SONNET, scraper: SONNET, reviewer: SONNET } },
]

export const DEFAULT_PROFILE = 'quick'

export const profileById = (id: string | null | undefined): AgentProfile => PROFILES.find((p) => p.id === id) ?? PROFILES.find((p) => p.id === DEFAULT_PROFILE)!

// ── the log of chats per profile ─────────────────────────────────────────────

export interface ChatRecord {
  /** The chat (one per New chat). */
  chat: string
  profile: string
  /** When the chat started (ms). */
  startedAt: number
  /** Finished turns so far. */
  turns: number
  /** Dollars at list prices, scout and scraper runs included (undefined: a model without a price). */
  cost?: number
  tokensIn: number
  tokensOut: number
  /** Scout and scraper runs sent. */
  runs: number
}

/** The log keeps the most recent chats only. */
export const MAX_RECORDS = 200

/** `log` with `rec` in place of the chat's earlier line (or added), newest last. */
export function recordChat(log: ChatRecord[], rec: ChatRecord): ChatRecord[] {
  const next = [...log.filter((r) => r.chat !== rec.chat), rec]
  return next.slice(-MAX_RECORDS)
}

export interface ProfileStats {
  chats: number
  /** Average dollars per chat, over chats with a known cost. */
  avgCost?: number
  avgRuns: number
}

/** Per profile: how many chats, their average cost and runs. Chats with no finished turn don't count. */
export function profileStats(log: ChatRecord[]): Record<string, ProfileStats> {
  const out: Record<string, ProfileStats> = {}
  for (const p of new Set(log.map((r) => r.profile))) {
    const rows = log.filter((r) => r.profile === p && r.turns > 0)
    if (!rows.length) continue
    const priced = rows.filter((r) => r.cost !== undefined)
    out[p] = {
      chats: rows.length,
      ...(priced.length ? { avgCost: priced.reduce((s, r) => s + r.cost!, 0) / priced.length } : {}),
      avgRuns: rows.reduce((s, r) => s + r.runs, 0) / rows.length,
    }
  }
  return out
}

/** "3 chats · ≈ $0.12 a chat" (empty with no chats). */
export function statsLine(s: ProfileStats | undefined): string {
  if (!s) return ''
  const cost = s.avgCost === undefined ? '' : ` · ≈ $${s.avgCost < 0.995 ? s.avgCost.toFixed(2) : s.avgCost.toFixed(s.avgCost < 10 ? 2 : 1)} a chat`
  return `${s.chats} chat${s.chats === 1 ? '' : 's'}${cost}`
}

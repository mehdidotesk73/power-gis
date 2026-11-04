// The app's managed agents on the user's own Anthropic account. Agents belong to
// the workspace of the key that made them, so each user's account gets its own:
// one environment and one agent per role, made from the definitions in this app
// (managed.ts: ROLE_PROMPTS, ENV_CONFIG) the first time they're needed.
//
// Found again by their metadata tag, never by this browser's memory alone: a new
// device, a cleared browser or another key reuses what the account already has,
// and a changed prompt updates the agent in place (a new version of the same
// agent) — agents can only be archived, never deleted, so every extra one would
// stay in the user's console for good. The model is chosen per run (a session
// override), so profiles don't need agents of their own. What this browser
// remembers (`powergis.managed`, under a hash of the key, never the key) only
// skips the lookup; if it's stale, the caller looks again (`forgetSetup`).

/** The tag on everything the app makes on an account. */
export const APP_TAG = 'powergis'
/** Bump when the environment's settings change (it's then made again, tagged with the new value). */
export const ENV_TAG = 'cloud-unrestricted-1'

export interface AgentLike {
  id: string
  version: number
  name: string
  system?: string | null
  metadata?: Record<string, string> | null
  updated_at?: string
  archived_at?: string | null
}
export interface EnvironmentLike {
  id: string
  name: string
  metadata?: Record<string, string> | null
  updated_at?: string
  archived_at?: string | null
}

/** The slice of the SDK this needs (a fake in tests). Lists are async iterables, as the SDK's pages are. */
export interface Account {
  beta: {
    agents: {
      list(params?: object): AsyncIterable<AgentLike>
      create(params: object): Promise<AgentLike>
      update(id: string, params: object): Promise<AgentLike>
    }
    environments: {
      list(params?: object): AsyncIterable<EnvironmentLike>
      create(params: object): Promise<EnvironmentLike>
      update(id: string, params: object): Promise<EnvironmentLike>
    }
  }
}

export interface Definition {
  role: string
  system: string
  /** Any model: each run names its own. */
  model: string
  tools: object[]
}

export interface Setup {
  environmentId: string
  agent: { id: string; version: number }
}

/** A short, stable fingerprint of a text (FNV-1a, 32 bits, hex): enough to tell prompt versions apart. */
export function textHash(t: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const newest = <T extends { updated_at?: string }>(xs: T[]): T | undefined =>
  [...xs].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0]
const live = <T extends { archived_at?: string | null }>(x: T) => !x.archived_at

/**
 * The role's agent among the account's: the newest tagged one, else the newest
 * untagged one an older version of the app made (`powergis-<role>`), adopted.
 */
export function pickAgent(agents: AgentLike[], role: string): { agent: AgentLike; tagged: boolean } | null {
  const mine = agents.filter(live)
  const tagged = newest(mine.filter((a) => a.metadata?.app === APP_TAG && a.metadata?.role === role))
  if (tagged) return { agent: tagged, tagged: true }
  const legacy = newest(mine.filter((a) => a.name === `${APP_TAG}-${role}` && !a.metadata?.app))
  return legacy ? { agent: legacy, tagged: false } : null
}

/** The data environment: the newest tagged with the current settings, else an untagged `powergis-data` (adopted). */
export function pickEnvironment(envs: EnvironmentLike[]): { env: EnvironmentLike; tagged: boolean } | null {
  const mine = envs.filter(live)
  const tagged = newest(mine.filter((e) => e.metadata?.app === APP_TAG && e.metadata?.env === ENV_TAG))
  if (tagged) return { env: tagged, tagged: true }
  const legacy = newest(mine.filter((e) => e.name === `${APP_TAG}-data` && !e.metadata?.app))
  return legacy ? { env: legacy, tagged: false } : null
}

async function all<T>(xs: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of xs) out.push(x)
  return out
}

/** The account's environment, found or made. */
export async function ensureEnvironment(c: Account, config: object): Promise<string> {
  const found = pickEnvironment(await all(c.beta.environments.list()))
  const metadata = { app: APP_TAG, env: ENV_TAG }
  if (found?.tagged) return found.env.id
  if (found) return (await c.beta.environments.update(found.env.id, { metadata })).id
  return (await c.beta.environments.create({ name: `${APP_TAG}-data`, config, metadata })).id
}

/** The role's agent, found or made, its prompt brought up to date in place. */
export async function ensureAgent(c: Account, def: Definition, retried = false): Promise<{ id: string; version: number }> {
  const prompt = textHash(def.system)
  const metadata = { app: APP_TAG, role: def.role, prompt }
  const found = pickAgent(await all(c.beta.agents.list()), def.role)
  if (!found) {
    const a = await c.beta.agents.create({ name: `${APP_TAG}-${def.role}`, model: def.model, system: def.system, tools: def.tools, metadata })
    return { id: a.id, version: a.version }
  }
  const { agent, tagged } = found
  if (tagged && agent.metadata?.prompt === prompt) return { id: agent.id, version: agent.version }
  // A newer prompt, or an older app's agent: updated in place (version guards against a concurrent update).
  try {
    const a = await c.beta.agents.update(agent.id, { system: def.system, tools: def.tools, metadata, version: agent.version })
    return { id: a.id, version: a.version }
  } catch (e) {
    // Another device updated it a moment ago (409): look again, once.
    if ((e as { status?: number })?.status === 409 && !retried) return ensureAgent(c, def, true)
    throw e
  }
}

// ── what this browser remembers (skips the lookup) ─────────────────────────

const STORE = 'powergis.managed'
interface Remembered {
  /** By key hash. */
  [keyHash: string]: { environmentId?: string; agents?: Record<string, { id: string; version: number; prompt: string }> }
}
const read = (): Remembered => {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? '{}') as unknown
    // The older shape ({environmentId, agents: {"role:model": …}}) isn't keyed: dropped, the lookup finds them.
    return v && typeof v === 'object' && !('environmentId' in v) && !('agents' in v) ? (v as Remembered) : {}
  } catch {
    return {}
  }
}
const write = (r: Remembered) => {
  try {
    localStorage.setItem(STORE, JSON.stringify(r))
  } catch {
    /* found again next time */
  }
}

/** A hash of the key, to keep each account's ids apart (the key itself is never stored). */
export async function keyHash(apiKey: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey)))
  return Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The environment and the role's agent: remembered, else looked up on the account (and made or updated as needed). */
export async function ensureSetup(c: Account, key: string, def: Definition, envConfig: object): Promise<Setup> {
  const mem = read()
  const mine = mem[key] ?? {}
  const prompt = textHash(def.system)
  const have = mine.agents?.[def.role]
  if (mine.environmentId && have && have.prompt === prompt) return { environmentId: mine.environmentId, agent: { id: have.id, version: have.version } }
  const environmentId = mine.environmentId ?? (await ensureEnvironment(c, envConfig))
  const agent = await ensureAgent(c, def)
  write({ ...mem, [key]: { environmentId, agents: { ...mine.agents, [def.role]: { ...agent, prompt } } } })
  return { environmentId, agent }
}

/** Forgets this browser's ids for the key (one was archived or deleted on the account): the next run looks again. */
export function forgetSetup(key: string) {
  const mem = read()
  delete mem[key]
  write(mem)
}

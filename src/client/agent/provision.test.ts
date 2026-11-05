import { beforeEach, describe, expect, it } from 'vitest'
import { APP_TAG, ENV_TAG, ensureAgent, ensureEnvironment, ensureSetup, forgetSetup, keyHash, pickAgent, pickEnvironment, textHash, type Account, type AgentLike, type EnvironmentLike } from './provision'

// A user's Anthropic account, in memory: what the app finds there, makes and updates.
function fakeAccount(agents: AgentLike[] = [], envs: EnvironmentLike[] = []) {
  const calls: string[] = []
  let n = 0
  const iter = <T>(xs: T[]) => ({ async *[Symbol.asyncIterator]() { yield* xs } })
  const account: Account = {
    beta: {
      agents: {
        list: () => (calls.push('agents.list'), iter(agents)),
        async create(p) {
          calls.push('agents.create')
          const a = { id: `agent_${++n}`, version: 1, updated_at: `2026-11-0${n}`, ...(p as object) } as AgentLike
          agents.push(a)
          return a
        },
        async update(id, p) {
          calls.push(`agents.update ${id}`)
          const a = agents.find((x) => x.id === id)!
          Object.assign(a, p, { version: a.version + 1 })
          return a
        },
      },
      environments: {
        list: () => (calls.push('environments.list'), iter(envs)),
        async create(p) {
          calls.push('environments.create')
          const e = { id: `env_${++n}`, ...(p as object) } as EnvironmentLike
          envs.push(e)
          return e
        },
        async update(id, p) {
          calls.push(`environments.update ${id}`)
          const e = envs.find((x) => x.id === id)!
          Object.assign(e, p)
          return e
        },
      },
    },
  }
  return { account, agents, envs, calls }
}

const def = (system = 'You are a data scout.') => ({ role: 'scout', system, model: 'claude-haiku-4-5', tools: [] })

beforeEach(() => {
  const mem = new Map<string, string>()
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  })
})

describe('managed agents on the user’s account', () => {
  it('picks the newest tagged agent for the role, ignoring archived ones and other roles', () => {
    const tag = (role: string) => ({ app: APP_TAG, role, prompt: 'x' })
    const agents: AgentLike[] = [
      { id: 'a1', version: 1, name: 'powergis-scout', metadata: tag('scout'), updated_at: '2026-11-01' },
      { id: 'a2', version: 3, name: 'powergis-scout', metadata: tag('scout'), updated_at: '2026-11-03' },
      { id: 'a3', version: 1, name: 'powergis-scout', metadata: tag('scout'), updated_at: '2026-11-04', archived_at: '2026-11-04' },
      { id: 'a4', version: 1, name: 'powergis-scraper', metadata: tag('scraper'), updated_at: '2026-11-05' },
      { id: 'a5', version: 1, name: 'something else', updated_at: '2026-11-06' },
    ]
    expect(pickAgent(agents, 'scout')).toEqual({ agent: agents[1], tagged: true })
    expect(pickAgent(agents, 'scraper')?.agent.id).toBe('a4')
    expect(pickAgent(agents, 'reviewer')).toBeNull()
  })

  it('adopts an older app’s untagged agent and environment by name', () => {
    expect(pickAgent([{ id: 'old', version: 2, name: 'powergis-scout' }], 'scout')).toEqual({ agent: { id: 'old', version: 2, name: 'powergis-scout' }, tagged: false })
    expect(pickEnvironment([{ id: 'e', name: 'powergis-data' }])?.tagged).toBe(false)
    // An environment tagged with older settings isn't used: a new one is made.
    expect(pickEnvironment([{ id: 'e', name: 'powergis-data', metadata: { app: APP_TAG, env: 'older' } }])).toBeNull()
  })

  it('makes the agent once; a second device finds it instead of making another', async () => {
    const acc = fakeAccount()
    const first = await ensureAgent(acc.account, def())
    const second = await ensureAgent(acc.account, def())
    expect(second).toEqual(first)
    expect(acc.agents).toHaveLength(1)
    expect(acc.agents[0].metadata).toEqual({ app: APP_TAG, role: 'scout', prompt: textHash('You are a data scout.') })
  })

  it('updates the agent in place when the prompt changes (a new version, not a new agent)', async () => {
    const acc = fakeAccount()
    const a = await ensureAgent(acc.account, def('v1'))
    const b = await ensureAgent(acc.account, def('v2'))
    expect(b).toEqual({ id: a.id, version: a.version + 1 })
    expect(acc.agents).toHaveLength(1)
    expect(acc.agents[0].system).toBe('v2')
    expect(acc.calls.filter((c) => c === 'agents.create')).toHaveLength(1)
  })

  it('tags an older app’s agent and environment instead of making new ones', async () => {
    const acc = fakeAccount([{ id: 'old', version: 4, name: 'powergis-scout', system: 'old prompt' }], [{ id: 'oldenv', name: 'powergis-data' }])
    expect(await ensureAgent(acc.account, def())).toEqual({ id: 'old', version: 5 })
    expect(await ensureEnvironment(acc.account, {})).toBe('oldenv')
    expect(acc.envs[0].metadata).toEqual({ app: APP_TAG, env: ENV_TAG })
    expect(acc.calls).not.toContain('agents.create')
    expect(acc.calls).not.toContain('environments.create')
  })

  it('remembers the ids per key: no lookup next time, a fresh lookup after forgetSetup or with another key', async () => {
    const acc = fakeAccount()
    const k1 = await keyHash('sk-ant-one')
    const k2 = await keyHash('sk-ant-two')
    expect(k1).not.toBe(k2)
    const s1 = await ensureSetup(acc.account, k1, def(), {})
    expect(localStorage.getItem('powergis.managed')).toContain(k1)
    expect(localStorage.getItem('powergis.managed')).not.toContain('sk-ant') // the key itself is never stored
    acc.calls.length = 0
    expect(await ensureSetup(acc.account, k1, def(), {})).toEqual(s1)
    expect(acc.calls).toEqual([]) // remembered: nothing asked
    forgetSetup(k1)
    expect(await ensureSetup(acc.account, k1, def(), {})).toEqual(s1) // found again, not made again
    expect(acc.calls).toContain('agents.list')
    expect(acc.agents).toHaveLength(1)
    expect(acc.envs).toHaveLength(1)
    acc.calls.length = 0
    await ensureSetup(acc.account, k2, def(), {}) // another key: looked up (the fake is one account, so found)
    expect(acc.calls).toContain('agents.list')
    expect(acc.agents).toHaveLength(1)
  })

  it('a changed prompt skips the remembered ids and updates the agent', async () => {
    const acc = fakeAccount()
    const k = await keyHash('sk-ant-one')
    const s1 = await ensureSetup(acc.account, k, def('v1'), {})
    const s2 = await ensureSetup(acc.account, k, def('v2'), {})
    expect(s2.agent).toEqual({ id: s1.agent.id, version: s1.agent.version + 1 })
    expect(s2.environmentId).toBe(s1.environmentId)
  })

  it('drops the older, unkeyed memory (the lookup finds the agents instead)', async () => {
    localStorage.setItem('powergis.managed', JSON.stringify({ environmentId: 'env_x', agents: { 'scout:m': { id: 'agent_x', version: 1, key: 'k' } } }))
    const acc = fakeAccount()
    const s = await ensureSetup(acc.account, await keyHash('sk'), def(), {})
    expect(s.environmentId).not.toBe('env_x')
    expect(s.agent.id).not.toBe('agent_x')
  })
  it('another device updating the agent at the same moment (409) is met by looking again', async () => {
    const acc = fakeAccount()
    await ensureAgent(acc.account, def('v1'))
    const update = acc.account.beta.agents.update
    let first = true
    acc.account.beta.agents.update = async (id, p) => {
      if (first) {
        first = false
        await update(id, p) // the other device's update lands first…
        throw Object.assign(new Error('version conflict'), { status: 409 })
      }
      return update(id, p)
    }
    const a = await ensureAgent(acc.account, def('v2'))
    expect(acc.agents).toHaveLength(1)
    expect(a.id).toBe(acc.agents[0].id)
    expect(acc.agents[0].system).toBe('v2')
  })
})

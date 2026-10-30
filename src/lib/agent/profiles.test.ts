import { describe, expect, it } from 'vitest'
import { MAX_RECORDS, PROFILES, profileById, profileStats, recordChat, statsLine, type ChatRecord } from './profiles'

const rec = (chat: string, profile: string, extra: Partial<ChatRecord> = {}): ChatRecord => ({ chat, profile, startedAt: 0, turns: 1, cost: 0.1, tokensIn: 100, tokensOut: 10, runs: 0, ...extra })

describe('profiles', () => {
  it('give every role a model, with unique ids', () => {
    expect(new Set(PROFILES.map((p) => p.id)).size).toBe(PROFILES.length)
    for (const p of PROFILES) for (const r of ['assistant', 'scout', 'scraper', 'reviewer'] as const) expect(p.models[r]).toMatch(/^claude-/)
  })
  it('fall back to the default for an unknown id', () => {
    expect(profileById('nope').id).toBe('quick')
    expect(profileById('planner').models.assistant).toBe('claude-opus-5-5')
  })
})

describe('the chat log', () => {
  it('keeps one line per chat, the latest', () => {
    let log = recordChat([], rec('a', 'quick', { turns: 1, cost: 0.1 }))
    log = recordChat(log, rec('b', 'quick'))
    log = recordChat(log, rec('a', 'quick', { turns: 2, cost: 0.3 }))
    expect(log.map((r) => [r.chat, r.turns])).toEqual([
      ['b', 1],
      ['a', 2],
    ])
  })
  it('keeps the most recent chats only', () => {
    let log: ChatRecord[] = []
    for (let i = 0; i < MAX_RECORDS + 5; i++) log = recordChat(log, rec(String(i), 'quick'))
    expect(log).toHaveLength(MAX_RECORDS)
    expect(log[0].chat).toBe('5')
  })
  it('averages cost and runs per profile', () => {
    const s = profileStats([rec('a', 'quick', { cost: 0.1, runs: 1 }), rec('b', 'quick', { cost: 0.3, runs: 0 }), rec('c', 'balanced', { cost: undefined }), rec('d', 'planner', { turns: 0 })])
    expect(s.quick.chats).toBe(2)
    expect(s.quick.avgCost).toBeCloseTo(0.2)
    expect(s.quick.avgRuns).toBe(0.5)
    expect(s.balanced.avgCost).toBeUndefined()
    expect(s.planner).toBeUndefined()
    expect(statsLine(s.quick)).toBe('2 chats · ≈ $0.20 a chat')
    expect(statsLine(s.balanced)).toBe('1 chat')
    expect(statsLine(undefined)).toBe('')
  })
})

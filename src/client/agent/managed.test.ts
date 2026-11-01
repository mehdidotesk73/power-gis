import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { asRunError, causeOf, describeTool, expectedFiles, RunError, SignInNeeded, traceText, withoutFilesLine } from './managed'
import { chatCost } from './claude'

describe('describeTool', () => {
  it('shows a URL on its own, so it links cleanly', () => {
    expect(describeTool('web_fetch', { url: 'https://ir.homedepot.com/financial-reports/annual-reports/recent' })).toBe(
      'web_fetch https://ir.homedepot.com/financial-reports/annual-reports/recent',
    )
  })
  it('shows a search query, a command’s first line, a file, or the JSON', () => {
    expect(describeTool('web_search', { query: 'census acs b19013' })).toBe('web_search “census acs b19013”')
    expect(describeTool('bash', { command: 'cd /tmp\npython3 x.py\nls' })).toBe('bash: cd /tmp (+2 lines)')
    expect(describeTool('write', { file_path: '/mnt/session/outputs/script.py', content: 'x' })).toBe('write /mnt/session/outputs/script.py')
    expect(describeTool('other', { a: 1 })).toBe('other {"a":1}')
  })
})

describe('the files a run reports', () => {
  it('reads the last FILES line, file names only', () => {
    const report = 'Wrote both.\n\n**FILES:** `rents.csv`, /mnt/session/outputs/states.geojson, script.py'
    expect(expectedFiles(report)).toEqual(['rents.csv', 'states.geojson', 'script.py'])
    expect(withoutFilesLine(report)).toBe('Wrote both.')
    expect(expectedFiles('No files line')).toEqual([])
    expect(expectedFiles('FILES: none')).toEqual([])
  })
})

describe('the chat cost', () => {
  it('prices tokens at list prices, cache writes and reads included', () => {
    const u = { input: 100_000, output: 10_000, cacheRead: 1_000_000, cacheWrite: 100_000 }
    // Haiku 5.5: $0.10 in / $0.50 out per million.
    expect(chatCost(u, 'claude-haiku-5-5')).toBeCloseTo(0.01 + 0.0125 + 0.01 + 0.005, 6)
    expect(chatCost(u, 'claude-haiku-4-5')).toBeUndefined()
  })
})

describe('what a failed run call means', () => {
  const api = (status: number, message: string) => Anthropic.APIError.generate(status, { error: { message } }, message, new Headers())
  it('tells the relay refusing the sign-in from Anthropic refusing the key', () => {
    expect(causeOf(api(401, 'Sign in to PowerGIS to use the relay (the request carried no valid session token)')).cause).toBe('sign-in')
    expect(causeOf(api(401, 'No Anthropic key reached the relay (headers received: …)')).cause).toBe('key')
    expect(causeOf(api(401, 'invalid x-api-key')).cause).toBe('key')
    expect(causeOf(new SignInNeeded()).cause).toBe('sign-in')
    expect(causeOf(new Anthropic.APIConnectionError({ message: 'Load failed' })).cause).toBe('network')
    expect(causeOf(api(500, 'overloaded')).cause).toBe('other')
  })
  it('says where it failed, why, whether the run goes on, and its id', () => {
    const e = asRunError(api(401, 'Sign in to PowerGIS to use the relay'), 'follow', 'sesn_1')
    expect(e).toBeInstanceOf(RunError)
    expect(e.message).toMatch(/^Failed while following the run: your PowerGIS sign-in was refused by the relay/)
    expect(e.message).toContain('carries on, or has finished')
    expect(e.message).toContain('Run id: sesn_1.')
    expect(asRunError(e, 'results')).toBe(e) // already wrapped: kept
    expect(asRunError(new Anthropic.APIConnectionError({ message: 'x' }), 'launch').message).toContain('The run did not start (nothing was spent).')
  })
})

describe('a run read back by id', () => {
  it('reads as lines: status, files, events (with what was left out), the last message', () => {
    const events = Array.from({ length: 8 }, (_, i) => ({ kind: 'tool' as const, text: `step ${i}` }))
    const text = traceText({ sessionId: 'sesn_1', status: 'idle', stop: 'end_turn', cost: 0.42, activeSeconds: 61, events, omitted: 30, lastMessage: 'Wrote rents.csv', files: [{ id: 'f', name: 'rents.csv', bytes: 40 }] })
    expect(text.split('\n').slice(0, 2)).toEqual(['run sesn_1: status idle, stopped: end_turn, cost $0.42, active 61 s', 'files: rents.csv (40 bytes)'])
    expect(text).toContain('… 30 events left out …\n[tool] step 2')
    expect(text.endsWith('last message:\nWrote rents.csv')).toBe(true)
  })
})

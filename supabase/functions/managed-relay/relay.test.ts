import { describe, expect, it } from 'vitest'
import { relay } from './index'

const BASE = 'https://ref.supabase.co/functions/v1/managed-relay'
type Call = { url: string; init: RequestInit }
const fake = (calls: Call[], answer = () => new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req_1', 'set-cookie': 'x=1' } })) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer()
  }) as unknown as typeof fetch

describe('managed-relay', () => {
  it('answers the browser preflight with the headers it asked for', async () => {
    const r = await relay(new Request(`${BASE}/v1/sessions?beta=true`, { method: 'OPTIONS', headers: { 'access-control-request-headers': 'x-api-key,x-stainless-os' } }))
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('access-control-allow-headers')).toBe('x-api-key,x-stainless-os')
  })

  it('forwards a Managed Agents call with only the headers Anthropic needs', async () => {
    const calls: Call[] = []
    const r = await relay(
      new Request(`${BASE}/v1/sessions?beta=true`, {
        method: 'POST',
        headers: { 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'managed-agents-2026-04-01', 'content-type': 'application/json', apikey: 'sb_publishable', cookie: 'c=1' },
        body: '{"title":"t"}',
      }),
      fake(calls),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/sessions?beta=true')
    const sent = calls[0].init.headers as Headers
    expect([...sent.keys()].sort()).toEqual(['anthropic-beta', 'anthropic-version', 'content-type', 'x-api-key'])
    expect(new TextDecoder().decode(calls[0].init.body as ArrayBuffer)).toBe('{"title":"t"}')
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual({ ok: true })
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('request-id')).toBe('req_1')
    expect(r.headers.get('set-cookie')).toBeNull()
  })

  it('works without the gateway prefix and keeps nested paths', async () => {
    const calls: Call[] = []
    await relay(new Request('http://localhost/managed-relay/v1/files/file_1/content?beta=true'), fake(calls))
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/files/file_1/content?beta=true')
    expect(calls[0].init.body).toBeUndefined()
  })

  it('refuses anything but the Managed Agents paths', async () => {
    const calls: Call[] = []
    for (const p of ['/v1/messages', '/v1/agentsx', '/', '/v1/organizations/me']) {
      const r = await relay(new Request(`${BASE}${p}`, { method: 'POST', body: '{}' }), fake(calls))
      expect(r.status).toBe(404)
      expect(r.headers.get('access-control-allow-origin')).toBe('*')
    }
    expect(calls).toHaveLength(0)
  })

  it('passes Anthropic errors back as they are, and says when it can’t reach Anthropic', async () => {
    const r = await relay(new Request(`${BASE}/v1/agents`), fake([], () => new Response('{"type":"error"}', { status: 401 })))
    expect(r.status).toBe(401)
    const down = await relay(new Request(`${BASE}/v1/agents`), (async () => { throw new Error('offline') }) as unknown as typeof fetch)
    expect(down.status).toBe(502)
    expect((await down.json()).error.message).toMatch(/offline/)
  })
})

// The scout / scraper relay (supabase/functions/managed-relay) as the browser
// meets it: through the local stack's gateway and Supabase's edge runtime.
// The last test reaches Anthropic (a bogus key, so a 401); set RELAY_OFFLINE=1
// where the stack can't reach it.
import { beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const base = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321'
const key = process.env.SUPABASE_TEST_KEY ?? ''
const url = `${base}/functions/v1/managed-relay`
const origin = 'https://deploy-preview-1--powergis.netlify.app'

/** A signed-in user's session token (the relay is for signed-in users). */
let token = ''
beforeAll(async () => {
  const sb = createClient(base, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await sb.auth.signUp({ email: `relay-${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'test-password-1' })
  if (error || !data.session) throw new Error(`sign up: ${error?.message ?? 'no session'}`)
  token = data.session.access_token
})

describe('managed-relay on the local stack', () => {
  it('lets a web page call it: the preflight answers with CORS, no Supabase token needed', async () => {
    const r = await fetch(`${url}/v1/sessions?beta=true`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key,anthropic-beta,anthropic-version,content-type,x-stainless-os,apikey' },
    })
    expect(r.ok).toBe(true)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('access-control-allow-headers')).toContain('x-stainless-os')
  })

  it('refuses anything but the Managed Agents API', async () => {
    const r = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(404)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('forwards nothing without a valid session token', async () => {
    for (const authorization of [undefined, 'Bearer not-a-token']) {
      const r = await fetch(`${url}/v1/agents?beta=true`, { headers: { origin, 'x-relay-key': 'sk-ant-bogus', apikey: key, ...(authorization ? { authorization } : {}) } })
      expect(r.status).toBe(401)
      expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/Sign in/)
    }
  })

  it("lets a signed-in user's request past its sign-in check", async () => {
    const r = await fetch(`${url}/v1/agents?beta=true`, { headers: { origin, authorization: `Bearer ${token}`, apikey: key, 'x-relay-key': 'sk-ant-bogus' } })
    expect(((await r.json()) as { error?: { message?: string } }).error?.message ?? '').not.toMatch(/Sign in/)
  })

  it.skipIf(!!process.env.RELAY_OFFLINE)('forwards to Anthropic and hands its answer back (a bogus key: 401)', async () => {
    const r = await fetch(`${url}/v1/agents?beta=true`, {
      headers: { origin, authorization: `Bearer ${token}`, apikey: key, 'x-relay-key': 'sk-ant-bogus', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'managed-agents-2026-04-01' },
    })
    expect(r.status).toBe(401)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(((await r.json()) as { error: { type: string } }).error.type).toBe('authentication_error')
  })
})

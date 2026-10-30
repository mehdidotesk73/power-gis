// A relay for Anthropic's Managed Agents API (the scout and the scraper,
// src/client/agent/managed.ts). Those endpoints refuse calls straight from a
// web page (their CORS preflight answers 400 / 405), so the page calls this
// Supabase Edge Function instead and it forwards the request as is.
//
// It forwards only the Managed Agents paths (environments, agents, sessions,
// files), and only the headers they need. The caller's own Anthropic key rides
// along on every request, in `x-relay-key` as well as the SDK's `x-api-key`
// (Supabase's hosted gateway doesn't pass `x-api-key` on); nothing is stored
// or logged. Only signed-in PowerGIS users may use it: every call carries the
// user's Supabase session token, checked with Supabase Auth (cached a minute). Each call
// is short: the page polls a session's events rather than holding a stream.
//
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function → via
// editor, name `managed-relay`, paste this file, and turn **Verify JWT** off
// (the relay checks the user's token itself; the gateway's check would also
// refuse the browser's preflight, which carries no token).
// Locally (tests/cloud), `supabase start` serves it; config.toml turns JWT off.

const UPSTREAM = 'https://api.anthropic.com'
const ALLOWED = /^\/v1\/(environments|agents|sessions|files)(\/|$)/
const FORWARD = ['anthropic-version', 'anthropic-beta', 'content-type', 'accept']
/** Where the caller's Anthropic key may arrive, in order. */
const KEY_HEADERS = ['x-relay-key', 'x-api-key']
const PASS_BACK = ['content-type', 'request-id', 'content-disposition', 'retry-after']

/** Where the relay checks a session token: the project's own Auth. */
export interface AuthEnv {
  url?: string
  key?: string
}
const denoEnv = (globalThis as { Deno?: { env: { get(name: string): string | undefined } } }).Deno?.env
const ENV: AuthEnv = { url: denoEnv?.get('SUPABASE_URL'), key: denoEnv?.get('SUPABASE_ANON_KEY') }

/** Tokens Auth accepted lately, with when to ask again (a run polls every few seconds). */
const accepted = new Map<string, number>()
const TOKEN_TTL = 60_000

async function signedIn(req: Request, fetchFn: typeof fetch, env: AuthEnv): Promise<boolean> {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  if (!token || !env.url) return false
  const until = accepted.get(token)
  if (until && until > Date.now()) return true
  const key = env.key ?? req.headers.get('apikey') ?? ''
  const r = await fetchFn(`${env.url}/auth/v1/user`, { headers: { authorization: `Bearer ${token}`, apikey: key } }).catch(() => null)
  if (!r?.ok) return false
  if (accepted.size > 500) accepted.clear()
  accepted.set(token, Date.now() + TOKEN_TTL)
  return true
}

const cors = (req: Request): Record<string, string> => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': req.headers.get('access-control-request-headers') ?? [...KEY_HEADERS, ...FORWARD].join(', '),
  'access-control-expose-headers': 'request-id, retry-after',
  'access-control-max-age': '600',
})

const refuse = (req: Request, status: number, message: string) =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'relay_error', message } }), { status, headers: { ...cors(req), 'content-type': 'application/json' } })

/** Answers one request: a preflight, a refusal, or Anthropic's answer to the forwarded call. */
export async function relay(req: Request, fetchFn: typeof fetch = fetch, env: AuthEnv = ENV): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) })
  const url = new URL(req.url)
  // The function sees its own name first (/managed-relay/v1/…), behind the gateway's /functions/v1 or not.
  const path = url.pathname.replace(/^.*?\/managed-relay(?=\/|$)/, '')
  if (!ALLOWED.test(path)) return refuse(req, 404, `The relay only forwards Managed Agents requests, not ${path || '/'}`)
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return refuse(req, 405, `${req.method} isn't forwarded`)
  if (!(await signedIn(req, fetchFn, env))) return refuse(req, 401, 'Sign in to PowerGIS to use the relay (the request carried no valid session token)')
  const key = KEY_HEADERS.map((h) => req.headers.get(h)).find((v) => v)
  // Names only, never values: says which headers made it through the gateway when the key didn't.
  if (!key) return refuse(req, 401, `No Anthropic key reached the relay (headers received: ${[...req.headers.keys()].sort().join(', ')})`)
  const headers = new Headers({ 'x-api-key': key })
  for (const h of FORWARD) {
    const v = req.headers.get(h)
    if (v !== null) headers.set(h, v)
  }
  let upstream: Response
  try {
    upstream = await fetchFn(`${UPSTREAM}${path}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? await req.arrayBuffer() : undefined,
    })
  } catch (e) {
    return refuse(req, 502, `Couldn't reach Anthropic: ${(e as Error).message}`)
  }
  const out = new Headers(cors(req))
  for (const h of PASS_BACK) {
    const v = upstream.headers.get(h)
    if (v !== null) out.set(h, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

// Served in Supabase's edge runtime (Deno); imported by the unit tests in Node, where there's no Deno.
const deno = (globalThis as { Deno?: { serve: (handler: (req: Request) => Promise<Response>) => unknown } }).Deno
deno?.serve((req) => relay(req))

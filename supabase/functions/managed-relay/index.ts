// A relay for Anthropic's Managed Agents API (the scout and the scraper,
// src/client/agent/managed.ts). Those endpoints refuse calls straight from a
// web page (their CORS preflight answers 400 / 405), so the page calls this
// Supabase Edge Function instead and it forwards the request as is.
//
// It forwards only the Managed Agents paths (environments, agents, sessions,
// files), and only the headers they need. The caller's own Anthropic key rides
// along in `x-api-key` on every request; nothing is stored or logged. Each call
// is short: the page polls a session's events rather than holding a stream.
//
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function → via
// editor, name `managed-relay`, paste this file, and turn **Verify JWT** off
// (the page sends no Supabase token; the Anthropic key is what authorizes).
// Locally (tests/cloud), `supabase start` serves it; config.toml turns JWT off.

const UPSTREAM = 'https://api.anthropic.com'
const ALLOWED = /^\/v1\/(environments|agents|sessions|files)(\/|$)/
const FORWARD = ['x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type', 'accept']
const PASS_BACK = ['content-type', 'request-id', 'content-disposition', 'retry-after']

const cors = (req: Request): Record<string, string> => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': req.headers.get('access-control-request-headers') ?? FORWARD.join(', '),
  'access-control-expose-headers': 'request-id, retry-after',
  'access-control-max-age': '600',
})

const refuse = (req: Request, status: number, message: string) =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'relay_error', message } }), { status, headers: { ...cors(req), 'content-type': 'application/json' } })

/** Answers one request: a preflight, a refusal, or Anthropic's answer to the forwarded call. */
export async function relay(req: Request, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) })
  const url = new URL(req.url)
  // The function sees its own name first (/managed-relay/v1/…), behind the gateway's /functions/v1 or not.
  const path = url.pathname.replace(/^.*?\/managed-relay(?=\/|$)/, '')
  if (!ALLOWED.test(path)) return refuse(req, 404, `The relay only forwards Managed Agents requests, not ${path || '/'}`)
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return refuse(req, 405, `${req.method} isn't forwarded`)
  const headers = new Headers()
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

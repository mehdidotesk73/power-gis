import { describe, expect, it } from 'vitest'
import { startClaude, CLAUDE_MODEL } from './claude'

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }

/** One streamed Messages API response, as server-sent events. */
function sse(blocks: Block[], stop: string): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let out = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: CLAUDE_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 } } })
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    } else {
      out += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    out += ev('content_block_stop', { index })
  })
  out += ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } })
  return out + ev('message_stop', {})
}

function fakeApi(responses: string[]) {
  const requests: { headers: Headers; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    return new Response(responses.shift()!, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { fetchImpl, requests }
}

const tools = [{ name: 'get_workspace', description: 'Read it', inputSchema: { type: 'object', properties: {} } }]

describe('Claude adapter', () => {
  it('streams text, returns tool calls, and sends results back in Anthropic format', async () => {
    const { fetchImpl, requests } = fakeApi([
      sse([{ type: 'text', text: 'Looking. ' }, { type: 'tool_use', id: 'tu_1', name: 'get_workspace', input: {} }], 'tool_use'),
      sse([{ type: 'text', text: 'All set.' }], 'end_turn'),
    ])
    const s = startClaude({ apiKey: 'sk-test', model: 'claude-opus-5-5', system: 'SYSTEM', tools }, fetchImpl)
    const streamed: string[] = []
    const t1 = await s.send({ text: 'hello' }, { onText: (d) => streamed.push(d) })
    expect(t1).toMatchObject({ text: 'Looking. ', stop: 'tools', toolCalls: [{ id: 'tu_1', name: 'get_workspace', input: {} }], usage: { input: 100, output: 20, cacheRead: 40 } })
    expect(streamed).toEqual(['Looking. '])
    const t2 = await s.send({ toolResults: [{ id: 'tu_1', content: '{"ok":1}' }] }, {})
    expect(t2).toMatchObject({ text: 'All set.', stop: 'done', toolCalls: [] })

    const [r1, r2] = requests
    // The SDK picks the auth header; either way it carries the user's key.
    expect([r1.headers.get('x-api-key'), r1.headers.get('authorization')]).toContainEqual(expect.stringContaining('sk-test'))
    expect(r1.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(r1.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(r1.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', stream: true, system: 'SYSTEM', cache_control: { type: 'ephemeral' } })
    expect(r1.body.tools).toEqual([{ name: 'get_workspace', description: 'Read it', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true }])
    expect(r2.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking. ' }, { type: 'tool_use', id: 'tu_1', name: 'get_workspace', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":1}' }] },
    ])
  })

  it('resumes a paused turn, and answers tool calls left behind by a Stop', async () => {
    const { fetchImpl, requests } = fakeApi([
      sse([{ type: 'text', text: 'Part one. ' }], 'pause_turn'),
      sse([{ type: 'tool_use', id: 'tu_9', name: 'get_workspace', input: {} }], 'tool_use'),
      sse([{ type: 'text', text: 'OK.' }], 'end_turn'),
    ])
    const s = startClaude({ apiKey: 'k', system: 'S', tools }, fetchImpl)
    const t = await s.send({ text: 'go' }, {})
    expect(t).toMatchObject({ text: 'Part one. ', stop: 'tools' })
    expect(requests).toHaveLength(2) // the pause was resumed with the paused turn appended
    // The user stopped before the tool ran, then wrote again.
    await s.send({ text: 'never mind' }, {})
    const last = requests[2].body.messages as { role: string; content: { type: string; tool_use_id?: string; is_error?: boolean }[] }[]
    expect(last.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: 'Not run: the user stopped the work.', is_error: true }, { type: 'text', text: 'never mind' }] })
  })

  it('uses the chosen model, and server-side fallbacks only where the model has them', async () => {
    const { fetchImpl, requests } = fakeApi([sse([{ type: 'text', text: 'Hi' }], 'end_turn')])
    await startClaude({ apiKey: 'k', model: 'claude-haiku-5-5', system: 'S', tools }, fetchImpl).send({ text: 'go' }, {})
    expect(requests[0].body.model).toBe('claude-haiku-5-5')
    expect(requests[0].body).not.toHaveProperty('fallbacks')
    expect(requests[0].headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback')
  })

  it('sends attached images before the text', async () => {
    const { fetchImpl, requests } = fakeApi([sse([{ type: 'text', text: 'I see it.' }], 'end_turn')])
    await startClaude({ apiKey: 'k', system: 'S', tools }, fetchImpl).send({ text: 'What is this?', images: [{ mediaType: 'image/jpeg', data: 'AAAA' }] }, {})
    expect((requests[0].body.messages as { content: unknown[] }[])[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: 'What is this?' },
    ])
  })

  it('never hands back a tool call cut off by max_tokens', async () => {
    const { fetchImpl } = fakeApi([sse([{ type: 'tool_use', id: 'tu_1', name: 'get_workspace', input: {} }], 'max_tokens')])
    const s = startClaude({ apiKey: 'k', system: 'S', tools }, fetchImpl)
    expect(await s.send({ text: 'go' }, {})).toMatchObject({ stop: 'truncated', toolCalls: [] })
  })
})

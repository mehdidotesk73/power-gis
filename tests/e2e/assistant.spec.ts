// The assistant's question cards and its scraper, in the browser. The model and
// Anthropic's Managed Agents are faked at the network (no key, no cost): the
// model's turns are canned streams; the relay's answers are canned too. What's
// real is everything in the app: the cards, the answer sent back to the model,
// the run's card, and the scraper's CSV becoming a dataset.
import { expect, test, type Page, type Route } from '@playwright/test'
import { account, closeDevices, device, PHONE, reload, signIn } from './helpers'

test.afterEach(closeDevices)

/** A model turn as the Messages API streams it: optional text, then optional tool calls. */
function turn(o: { text?: string; tools?: { name: string; input: object }[] }): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let out = ev('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  let i = 0
  if (o.text) {
    out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
    out += ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: o.text } })
    out += ev('content_block_stop', { index: i++ })
  }
  for (const t of o.tools ?? []) {
    out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: t.name, input: {} } })
    out += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } })
    out += ev('content_block_stop', { index: i++ })
  }
  out += ev('message_delta', { delta: { stop_reason: o.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
  return out + ev('message_stop', {})
}

/** The model plays `turns` in order; answers each request's body to `seen`. */
async function fakeModel(page: Page, turns: Parameters<typeof turn>[0][], seen: unknown[]) {
  await page.context().route('https://api.anthropic.com/v1/messages**', async (route: Route) => {
    seen.push(route.request().postDataJSON())
    const next = turns.shift() ?? { text: 'Done.' }
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: turn(next) })
  })
}
/** The last tool result the app sent the model, parsed. */
function lastToolResult(seen: unknown[]): Record<string, unknown> {
  const body = seen[seen.length - 1] as { messages: { role: string; content: { type: string; content: unknown }[] | string }[] }
  const last = body.messages[body.messages.length - 1]
  const block = (last.content as { type: string; content: unknown }[]).find((b) => b.type === 'tool_result')!
  const text = typeof block.content === 'string' ? block.content : (block.content as { text: string }[])[0].text
  return JSON.parse(text)
}

async function openAssistant(page: Page) {
  await page.evaluate(() => localStorage.setItem('powergis.anthropicKey', 'sk-ant-test'))
  await reload(page)
  await page.getByRole('button', { name: 'Assistant' }).click()
}
async function say(page: Page, text: string) {
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('the assistant asks with a form: choices, its own answer, a drafted plan, and buttons', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  await fakeModel(
    page,
    [
      {
        text: 'Your workspace has county income for 2022 only.',
        tools: [
          {
            name: 'ask_user',
            input: {
              question: 'Which years should the map cover?',
              details: 'Income is there for 2022; rents would need the web.',
              fields: [
                { id: 'years', kind: 'choice', label: 'Years', options: ['2021', '2022', '2023'], multiple: true, other: true, selected: ['2022'] },
                { id: 'level', kind: 'choice', label: 'Level', options: ['County', 'State'] },
                { id: 'plan', kind: 'text', label: 'Plan', value: 'Clean the income table, then map it by county.', multiline: true, required: true },
              ],
              buttons: ['Build it', 'Skip rents', 'Not now'],
            },
          },
        ],
      },
      { text: 'Building it now.' },
    ],
    seen,
  )
  await openAssistant(page)
  await say(page, 'Map income and rent per county')

  const askCard = page.getByTestId('ask-card')
  await expect(askCard.getByText('Which years should the map cover?')).toBeVisible()
  await askCard.getByLabel('2023').check()
  await askCard.getByPlaceholder('Your own…').fill('2019')
  await askCard.getByLabel('State').check()
  await askCard.getByLabel('Plan').fill('Clean the income table, then map it by state.')
  await page.screenshot({ path: test.info().outputPath('ask-card-phone.png'), fullPage: false })
  await askCard.getByTestId('ask.button-0').click()

  await expect(page.getByText('Building it now.')).toBeVisible()
  expect(lastToolResult(seen)).toEqual({ button: 'Build it', values: { years: ['2022', '2023', '2019'], level: ['State'], plan: 'Clean the income table, then map it by state.' } })
  await expect(askCard.getByText('✓ Build it')).toBeVisible()
})

test('the scraper: signed in, the brief approved, its run followed, its CSV a new dataset', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  const brief = 'Fetch median rent per county from example.gov as rents.csv: fips (5-digit text), rent (dollars).'
  await fakeModel(page, [{ text: 'I can fetch rents.', tools: [{ name: 'send_scraper', input: { brief, cap_dollars: 2 } }] }, { text: 'Rents are in.' }], seen)

  // Anthropic's Managed Agents, as the relay would answer.
  const relay = new URL(`${process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321'}/functions/v1/managed-relay/`).href
  const asked: string[] = []
  const at = new Date().toISOString()
  await page.context().route(`${relay}**`, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(/^.*\/managed-relay/, '')
    asked.push(`${req.method()} ${path} ${req.headers().authorization ? 'signed' : 'anonymous'}`)
    const json = (body: object) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
    if (path === '/v1/environments') return json({ id: 'env_1' })
    if (path === '/v1/agents') return json({ id: 'agent_1', version: 1 })
    if (path === '/v1/sessions') return json({ id: 'sesn_1' })
    if (path === '/v1/sessions/sesn_1/events' && req.method() === 'POST') return json({ data: [] })
    if (path === '/v1/sessions/sesn_1/events')
      return json({
        data: [
          { id: 'e1', type: 'session.status_running', processed_at: at },
          { id: 'e2', type: 'agent.tool_use', name: 'web_fetch', input: { url: 'https://example.gov/rents' }, evaluated_permission: 'allow', processed_at: at },
          { id: 'e3', type: 'agent.message', content: [{ type: 'text', text: 'Wrote rents.csv: 2 rows, rent in dollars.' }], processed_at: at },
          { id: 'e4', type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: at },
        ],
        next_page: null,
      })
    if (path === '/v1/sessions/sesn_1') return json({ id: 'sesn_1', status: 'idle', usage: { list_cost: { amount: '3', currency: 'USD' }, active_seconds: 30 } })
    if (path === '/v1/files') return json({ data: [{ id: 'file_csv', filename: 'rents.csv', size_bytes: 40 }, { id: 'file_py', filename: 'script.py', size_bytes: 20 }], next_page: null })
    if (path === '/v1/files/file_csv/content') return route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'access-control-allow-origin': '*' }, body: 'fips,rent\n01001,980\n01003,1210\n' })
    return route.fulfill({ status: 404, body: 'not faked' })
  })

  await openAssistant(page)
  // Signed out, the tool refuses and says why.
  await say(page, 'Add rents per county')
  await page.getByTestId('ask.button-0').click()
  await expect(page.getByText('Rents are in.')).toBeVisible() // the fake model's next turn
  expect(JSON.stringify(seen[seen.length - 1])).toContain('Sign in')
  expect(asked).toEqual([])

  // Signed in, it runs.
  await signIn(page, await account('scraper'))
  await page.getByRole('button', { name: 'New chat' }).click()
  seen.length = 0
  await fakeModel(page, [{ text: 'I can fetch rents.', tools: [{ name: 'send_scraper', input: { brief, cap_dollars: 2 } }] }, { text: 'Rents are in.' }], seen)
  await say(page, 'Add rents per county')
  const approval = page.getByTestId('ask-card')
  await expect(approval.getByLabel('Brief')).toHaveValue(brief)
  await approval.getByLabel('$1', { exact: true }).check()
  await page.screenshot({ path: test.info().outputPath('scraper-approval-phone.png') })
  await approval.getByTestId('ask.button-0').click()

  const run = page.getByTestId('web-run')
  await expect(run).toContainText('finished')
  await expect(run).toContainText('1 dataset')
  await expect(page.getByText('Rents are in.')).toBeVisible()
  const result = lastToolResult(seen) as { files: { name: string; datasetId?: string }[]; cost: number }
  expect(result.cost).toBe(0.03)
  expect(result.files.map((f) => f.name)).toEqual(['rents.csv', 'script.py'])
  expect(result.files[0].datasetId).toBeTruthy()
  expect(asked.every((a) => a.endsWith('signed'))).toBe(true)
  await run.getByRole('button', { name: /Scraper/ }).click()
  await expect(run).toContainText('web_fetch https://example.gov/rents')
  await page.screenshot({ path: test.info().outputPath('scraper-run-phone.png') })

  await expect(run).toContainText('rents.csv → dataset “rents”')
})

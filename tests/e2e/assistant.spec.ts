// The assistant's question cards and its scraper, in the browser. The model and
// Anthropic's Managed Agents are faked at the network (no key, no cost): the
// model's turns are canned streams; the relay's answers are canned too. What's
// real is everything in the app: the cards, the answer sent back to the model,
// the run's card, and the scraper's CSV becoming a dataset.
import { expect, test, type Page, type Route } from '@playwright/test'
import { account, closeDevices, device, openWorkspacePanel, PHONE, reload, signIn } from './helpers'

test.afterEach(closeDevices)

/** A model turn as the Messages API streams it: optional text, then optional tool calls. */
function turn(o: { thinking?: string; text?: string; tools?: { name: string; input: object }[] }): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let out = ev('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  let i = 0
  if (o.thinking) {
    out += ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } })
    out += ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: o.thinking } })
    out += ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: 'sig' } })
    out += ev('content_block_stop', { index: i++ })
  }
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

test('the assistant asks a card of up to three questions, answered together by one button pair', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  const q = (x: Record<string, unknown>) => ({ why: '', text: '', options: [], recommended: '', neither: false, selected: [], required: false, ...x })
  await fakeModel(
    page,
    [
      {
        thinking: 'The user wants a map of income.\nCheck which years the workspace has first.',
        text: 'Your workspace has county income for 2022 only.',
        tools: [
          {
            name: 'ask_user',
            input: {
              title: 'How should the income map be built?',
              context: 'Income is there for 2022; rents would need the web.',
              questions: [
                q({ kind: 'answer', question: 'The plan', why: 'What I would build', text: 'Clean the income table, then map it by county.', required: true }),
                q({ kind: 'several', question: 'Which years?', options: ['2021', '2022', '2023'], selected: ['2022'] }),
                q({ kind: 'one', question: 'At what level?', why: 'Counties show more detail; states read faster.', options: ['State', 'County'], recommended: 'County', neither: true }),
              ],
              buttons: ['Build it', 'Not now'],
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
  await expect(askCard.getByText('How should the income map be built?')).toBeVisible()
  // The recommended option comes first, marked, and picked to start; a radio set offers Neither.
  await expect(askCard.getByTestId('ask.q3').locator('.option').first()).toContainText('County (recommended)')
  await expect(askCard.getByTestId('ask.q3').getByLabel('County')).toBeChecked()
  await askCard.getByLabel('The plan').fill('Clean the income table, then map it by state.')
  await askCard.getByLabel('2023').check()
  // Comments stay folded until asked for; Neither opens them.
  await askCard.getByTestId('ask.comment-2').click()
  await askCard.getByLabel('Comments: Which years?').fill('2019 too, if it exists')
  await askCard.getByTestId('ask.q3').getByLabel('Neither (see comments)').check()
  await askCard.getByLabel('Comments: At what level?').fill('Metro areas')
  await page.screenshot({ path: test.info().outputPath('ask-card-phone.png'), fullPage: false })
  await askCard.getByTestId('ask.button-0').click()

  await expect(page.getByText('Building it now.')).toBeVisible()
  // Its reasoning, folded to its first line; and the question it sent, as a step showing its input.
  const reasoning = page.getByTestId('agent.reasoning')
  await expect(reasoning).toContainText('The user wants a map of income.')
  await reasoning.getByRole('button').click()
  await expect(reasoning).toContainText('Check which years the workspace has first.')
  const step = page.locator('.tool', { hasText: 'Ask you' })
  await step.getByRole('button').click()
  await expect(step).toContainText('"title": "How should the income map be built?"')
  expect(lastToolResult(seen)).toEqual({
    button: 'Build it',
    answers: [
      { question: 'The plan', edited: true, text: 'Clean the income table, then map it by state.' },
      { question: 'Which years?', choices: ['2022', '2023'], comments: '2019 too, if it exists' },
      { question: 'At what level?', choice: null, neither: true, comments: 'Metro areas' },
    ],
    // Notes are instructions, ahead of the assistant's own draft (exchanges.ts USER_NOTES).
    note: expect.stringContaining("The user's notes are instructions and come before what you proposed"),
  })
  await expect(askCard.getByText('✓ Build it')).toBeVisible()
})

test('the Frame exchange: the framing, components with postures and the measure; approved, it is the Study frame in About', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  await fakeModel(
    page,
    [
      {
        text: 'Here is how I read it.',
        tools: [
          {
            name: 'propose_frame',
            input: {
              framing: 'The countries where a typical full-time worker earns the most in a year.',
              why: '',
              components: [
                { name: 'Average annual wage', posture: 'anchor + proxy', note: 'OECD, filled in from ILOSTAT', key: true },
                { name: 'Hours worked', posture: 'exact', note: '', key: false },
              ],
              decision: { question: 'In what money?', why: 'Market rates and buying power rank countries differently.', options: ['Market exchange rates', 'Buying power (PPP)'], recommended: 'Buying power (PPP)' },
            },
          },
        ],
      },
      { text: 'Framed. Next, the data.' },
    ],
    seen,
  )
  await openAssistant(page)
  await say(page, 'What are the best paid countries?')

  const card = page.getByTestId('ask-card')
  await expect(card).toContainText('Is this the question to answer?')
  await expect(card.getByTestId('ask.q2')).toContainText('Average annual wage — anchor + proxy: OECD, filled in from ILOSTAT')
  await expect(card.getByTestId('ask.q2').getByLabel(/Hours worked/)).not.toBeChecked()
  await expect(card.getByTestId('ask.q3').getByLabel('Buying power (PPP)')).toBeChecked()
  await expect(card.getByTestId('ask.revise')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('frame-card-phone.png') })
  await card.getByTestId('ask.button-0').click()

  await expect(page.getByText('Framed. Next, the data.')).toBeVisible()
  expect(lastToolResult(seen)).toMatchObject({ decision: 'approved', edited: false, measure: { question: 'In what money?', choice: 'Buying power (PPP)' }, kept: ['Average annual wage (anchor + proxy)'], leftOut: ['Hours worked'] })
  await page.getByLabel('Assistant').getByRole('button', { name: 'Close', exact: true }).click()
  await openWorkspacePanel(page)
  const about = page.getByTestId('workspace.about')
  await about.locator('summary').click()
  await expect(about.getByLabel('About this workspace')).toHaveValue(/^## Study frame\n\nThe countries where a typical full-time worker[\s\S]*\*\*In what money\?\*\* Buying power \(PPP\)/)
})

/** Anthropic's Managed Agents, as the relay would answer: one scraper session (sesn_1) that fetched a page and wrote rents.csv. */
/** `held.on`: the run stays running (its last events withheld) until the test lets it finish. */
async function fakeRelay(page: Page, held = { on: false }) {
  const relay = new URL(`${process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321'}/functions/v1/managed-relay/`).href
  const asked: string[] = []
  const agentModels: string[] = []
  const agents: { id: string; version: number }[] = []
  const envs: { id: string }[] = []
  const at = new Date().toISOString()
  await page.context().route(`${relay}**`, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(/^.*\/managed-relay/, '')
    asked.push(`${req.method()} ${path} ${req.headers().authorization ? 'signed' : 'anonymous'}`)
    const json = (body: object) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
    // The user's account: what the app finds there by its tag, makes (once) and updates (provision.ts).
    if (path === '/v1/environments' && req.method() === 'GET') return json({ data: envs, next_page: null })
    if (path === '/v1/environments') {
      envs.push({ id: `env_${envs.length + 1}`, ...req.postDataJSON() })
      return json(envs[envs.length - 1])
    }
    if (path === '/v1/agents' && req.method() === 'GET') return json({ data: agents, next_page: null })
    if (path === '/v1/agents') {
      agents.push({ id: `agent_${agents.length + 1}`, version: 1, ...req.postDataJSON() })
      return json(agents[agents.length - 1])
    }
    if (path === '/v1/sessions') {
      // The model is the run's own (a session override), the agent the account's one for the role.
      agentModels.push(JSON.stringify(req.postDataJSON()?.agent?.model))
      return json({ id: 'sesn_1' })
    }
    if (path === '/v1/sessions/sesn_1/events' && req.method() === 'POST') return json({ data: [] })
    if (path === '/v1/sessions/sesn_1/events' && held.on) return json({ data: [{ id: 'e1', type: 'session.status_running', processed_at: at }], next_page: null })
    if (path === '/v1/sessions/sesn_1/events')
      return json({
        data: [
          { id: 'e1', type: 'session.status_running', processed_at: at },
          { id: 'e2', type: 'agent.tool_use', name: 'web_fetch', input: { url: 'https://example.gov/rents' }, evaluated_permission: 'allow', processed_at: at },
          { id: 'e3', type: 'agent.message', content: [{ type: 'text', text: 'Wrote rents.csv: 2 rows, rent in dollars.\nFILES: rents.csv, script.py' }], processed_at: at },
          { id: 'e4', type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: at },
        ],
        next_page: null,
      })
    if (path === '/v1/sessions/sesn_1' && held.on) return json({ id: 'sesn_1', status: 'running' })
    if (path === '/v1/sessions/sesn_1') return json({ id: 'sesn_1', status: 'idle', usage: { list_cost: { amount: '3', currency: 'USD' }, active_seconds: 30 } })
    if (path === '/v1/files') return json({ data: [{ id: 'file_csv', filename: 'rents.csv', size_bytes: 40 }, { id: 'file_py', filename: 'script.py', size_bytes: 20 }], next_page: null })
    if (path === '/v1/files/file_csv/content') return route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'access-control-allow-origin': '*' }, body: 'fips,rent\n01001,980\n01003,1210\n' })
    return route.fulfill({ status: 404, body: 'not faked' })
  })
  return { asked, agentModels, agents, envs }
}

test('the scraper: signed in, the brief approved, its run followed, its CSV a new dataset', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  const brief = 'Fetch median rent per county from example.gov as rents.csv: fips (5-digit text), rent (dollars).'
  await fakeModel(page, [{ text: 'I can fetch rents.', tools: [{ name: 'send_scraper', input: { brief, cap_dollars: 2 } }] }, { text: 'Rents are in.' }], seen)

  const { asked, agentModels, agents, envs } = await fakeRelay(page)

  await openAssistant(page)
  // Signed out, the tool refuses before asking anything (no approval card), says why, and the chat offers Sign in.
  await say(page, 'Add rents per county')
  await expect(page.getByText('Rents are in.')).toBeVisible() // the fake model's next turn
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
  expect(JSON.stringify(seen[seen.length - 1])).toContain('Sign in')
  expect(asked).toEqual([])
  await page.getByTestId('agent.signin').click()
  const accountWindow = page.getByRole('dialog', { name: 'Account' })
  await expect(accountWindow).toBeVisible()
  await accountWindow.getByRole('button', { name: 'Close' }).click()

  // Signed in, it runs.
  await signIn(page, await account('scraper'))
  await page.getByRole('button', { name: 'New chat' }).click()
  // The Planner profile: the chat on Opus, its scraper on Haiku.
  await page.getByRole('button', { name: /Settings/ }).click()
  await page.getByTestId('profile.planner').click()
  await page.getByRole('button', { name: /Settings/ }).click()
  await expect(page.getByTestId('agent.profile')).toHaveText('Planner · Opus 5.5')
  seen.length = 0
  await fakeModel(page, [{ text: 'I can fetch rents.', tools: [{ name: 'send_scraper', input: { brief, cap_dollars: 2 } }] }, { text: 'Rents are in.' }], seen)
  await say(page, 'Add rents per county')
  const approval = page.getByTestId('ask-card')
  await expect(approval.getByLabel('The brief')).toHaveValue(brief)
  await approval.getByLabel('$1', { exact: true }).check()
  await page.screenshot({ path: test.info().outputPath('scraper-approval-phone.png') })
  await approval.getByTestId('ask.button-0').click()

  const run = page.getByTestId('web-run')
  await expect(run).toContainText('finished')
  await expect(run).toContainText('1 dataset')
  await expect(page.getByText('Rents are in.')).toBeVisible()
  const result = lastToolResult(seen) as { files: { name: string; datasetId?: string }[]; cost: number }
  expect(result.cost).toBe(0.03)
  expect((seen[0] as { model: string }).model).toBe('claude-opus-5-5')
  expect(agentModels.join()).toContain('claude-haiku-5-5')
  expect(result.files.map((f) => f.name)).toEqual(['rents.csv', 'script.py'])
  expect(result.files[0].datasetId).toBeTruthy()
  expect(asked.every((a) => a.endsWith('signed'))).toBe(true)
  await run.getByRole('button', { name: /Scraper/ }).click()
  await expect(run).toContainText('web_fetch https://example.gov/rents')
  await page.screenshot({ path: test.info().outputPath('scraper-run-phone.png') })

  await expect(run).toContainText('rents.csv → dataset “rents”')
  // The chat's cost: its tokens at list prices plus the run's $0.03.
  await expect(page.getByText(/≈ \$0\.03/)).toBeVisible()
  // The step shows the model it ran on.
  await expect(run.getByTestId('agent.step.model')).toHaveText('Haiku 5.5')

  // The profile changes mid-chat: a note says so; the chat's next call and the next run use the new models, the
  // finished run keeps its label, and the account's agent is reused (made once, never twice).
  await page.getByRole('button', { name: /Settings/ }).click()
  await page.getByTestId('profile.all-sonnet').click()
  await page.getByRole('button', { name: /Settings/ }).click()
  await expect(page.getByTestId('agent.profile')).toHaveText('All Sonnet · Sonnet 5.5')
  await expect(page.getByText('Profile changed to All Sonnet')).toBeVisible()
  seen.length = 0
  await fakeModel(page, [{ text: 'Again.', tools: [{ name: 'send_scraper', input: { brief, cap_dollars: 2 } }] }, { text: 'Rents again.' }], seen)
  await say(page, 'Fetch them again')
  await page.getByTestId('ask-card').last().getByTestId('ask.button-0').click()
  await expect(page.getByText('Rents again.')).toBeVisible()
  expect((seen[0] as { model: string }).model).toBe('claude-sonnet-5-5')
  const runs = page.getByTestId('web-run')
  await expect(runs).toHaveCount(2)
  await expect(runs.nth(0).getByTestId('agent.step.model')).toHaveText('Haiku 5.5')
  await expect(runs.nth(1).getByTestId('agent.step.model')).toHaveText('Sonnet 5.5')
  expect(agentModels[agentModels.length - 1]).toContain('claude-sonnet-5-5')
  expect(agents).toHaveLength(1)
  expect(envs).toHaveLength(1)
})

test('a diagnosis: asked first with its model, then a red report in the chat to copy', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  await fakeModel(
    page,
    [
      { text: 'The scraper failed twice.', tools: [{ name: 'diagnose', input: { what_happened: 'The scraper failed twice with "API key was not accepted"; run sesn_9 finished anyway.' } }] },
      { text: '## Summary\nThe relay refused a stale sign-in token.\n\n## Details for troubleshooting\nRun sesn_9' },
      { text: 'The report is in the chat.' },
    ],
    seen,
  )
  await openAssistant(page)
  await say(page, 'Why did the scraper fail?')

  const approval = page.getByTestId('ask-card')
  await expect(approval.getByText('Run a diagnosis of what went wrong?')).toBeVisible()
  await approval.getByLabel('Sonnet 5.5 · balanced').check()
  await approval.getByTestId('ask.button-0').click()

  const report = page.getByTestId('agent.diagnosis')
  await expect(report).toContainText('The relay refused a stale sign-in token.')
  await expect(page.getByText('The report is in the chat.')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('diagnosis-phone.png') })
  // The diagnosis call: the chosen model, its own prompt, no tools, the chat's steps in its input.
  const call = seen[1] as { model: string; system: unknown; tools?: unknown[]; messages: { content: unknown }[] }
  expect(call.model).toBe('claude-sonnet-5-5')
  expect(JSON.stringify(call.system)).toContain('Write an issue report')
  expect(call.tools ?? []).toEqual([])
  expect(JSON.stringify(call.messages)).toContain('Why did the scraper fail?')
  expect(JSON.stringify(lastToolResult(seen))).toContain('The relay refused')
  await report.getByTestId('agent.diagnosis.copy').click()
  await expect(report.getByTestId('agent.diagnosis.copy')).toContainText(/Copied|Copy report/)
})

test('the assistant looks inside a run by its id, changing nothing (read_run)', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  await fakeModel(page, [{ text: 'Let me look at that run.', tools: [{ name: 'read_run', input: { runId: 'sesn_1' } }] }, { text: 'It finished and wrote rents.csv.' }], seen)
  const { asked } = await fakeRelay(page)
  await signIn(page, await account('reader'))
  await openAssistant(page)
  await say(page, 'What happened to run sesn_1?')
  await expect(page.getByText('It finished and wrote rents.csv.')).toBeVisible()
  const trace = String(lastToolResult(seen).trace)
  expect(trace).toContain('run sesn_1: status idle, stopped: end_turn, cost $0.03, active 30 s')
  expect(trace).toContain('files: rents.csv (40 bytes), script.py (20 bytes)')
  expect(trace).toContain('[tool] web_fetch https://example.gov/rents')
  expect(trace).toContain('last message:\nWrote rents.csv')
  // Read only: nothing sent to the run, nothing downloaded, no dataset made.
  expect(asked.filter((a) => a.startsWith('POST') || a.includes('/content'))).toEqual([])
  await expect(page.locator('.tool', { hasText: 'Look inside a run' })).toContainText('idle · 2 files')
})

test('a turn that fails shows Retry and Diagnose: Retry carries on, Diagnose asks first', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  let failNext = true
  const turns = [{ text: 'Carrying on from where it stopped.' }, { text: '## Summary\nThe request was refused with a 400.' }]
  await page.context().route('https://api.anthropic.com/v1/messages**', async (route) => {
    seen.push(route.request().postDataJSON())
    if (failNext) {
      failNext = false
      return route.fulfill({ status: 400, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Something went wrong upstream' } }) })
    }
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: turn(turns.shift() ?? { text: 'Done.' }) })
  })
  await openAssistant(page)
  await say(page, 'Describe every dataset')
  const failed = page.getByTestId('agent.failed')
  await expect(failed).toContainText('Something went wrong upstream')
  await expect(page.getByTestId('agent.retry')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('turn-failed-phone.png') })

  await page.getByTestId('agent.retry').click()
  await expect(page.getByText('Carrying on from where it stopped.')).toBeVisible()
  expect(JSON.stringify(seen[1])).toContain('The last step failed')
  // Retry is gone once the chat moved on.
  await expect(page.getByTestId('agent.retry')).toHaveCount(0)

  // Diagnose from a failed card: the approval card first, then the red report.
  failNext = true
  await say(page, 'And the transforms?')
  await expect(page.getByTestId('agent.failed').last()).toBeVisible()
  await page.getByTestId('agent.diagnose').click()
  await expect(page.getByTestId('ask-card').last()).toContainText('Run a diagnosis of what went wrong?')
  await page.getByTestId('ask-card').last().getByTestId('ask.button-0').click()
  await expect(page.getByTestId('agent.diagnosis')).toContainText('The request was refused with a 400.')
})

test('the chat is kept on the device: a reload brings it back and the assistant carries on; New chat clears it', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  await fakeModel(page, [{ text: 'Reading it.', tools: [{ name: 'get_workspace', input: {} }] }, { text: 'Your workspace is empty.' }, { text: 'Still here.' }], seen)
  await openAssistant(page)
  await say(page, 'What is in my workspace?')
  await expect(page.getByText('Your workspace is empty.')).toBeVisible()

  await reload(page)
  await page.getByRole('button', { name: 'Assistant' }).click()
  await expect(page.getByText('What is in my workspace?')).toBeVisible()
  await expect(page.getByText('Your workspace is empty.')).toBeVisible()
  await expect(page.getByText('Read the workspace')).toBeVisible()

  // The assistant carries on with the whole conversation, not from scratch.
  await say(page, 'And now?')
  await expect(page.getByText('Still here.')).toBeVisible()
  const sent = JSON.stringify((seen[seen.length - 1] as { messages: unknown[] }).messages)
  expect(sent).toContain('What is in my workspace?')
  expect(sent).toContain('Your workspace is empty.')

  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page.getByText('What is in my workspace?')).toHaveCount(0)
  await reload(page)
  await page.getByRole('button', { name: 'Assistant' }).click()
  await expect(page.getByText('What is in my workspace?')).toHaveCount(0)
})

test('a reload in the middle of a scraper run: the chat comes back, the run carries on in its card, and the assistant is told', async ({ browser }) => {
  const page = await device(browser, PHONE)
  const seen: unknown[] = []
  const brief = 'Fetch median rent per county from example.gov as rents.csv: fips (5-digit text), rent (dollars).'
  const held = { on: true }
  await fakeRelay(page, held)
  await fakeModel(page, [{ text: 'I can fetch rents.', tools: [{ name: 'send_scraper', input: { brief, cap_dollars: 2 } }] }, { text: 'Reading the run.' }], seen)
  await openAssistant(page)
  await signIn(page, await account('reload-run'))
  await say(page, 'Add rents per county')
  await page.getByTestId('ask-card').getByTestId('ask.button-0').click()
  await expect(page.getByTestId('web-run')).toContainText('running')
  // Started at Anthropic (not still setting up): the device remembers it.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('powergis.webRun'))).toContain('sesn_1')

  await reload(page)
  await page.getByRole('button', { name: 'Assistant' }).click()
  await expect(page.getByText('Add rents per county')).toBeVisible()
  await expect(page.getByText('I can fetch rents.')).toBeVisible()
  await expect(page.getByText('The page was reloaded while the assistant was working')).toBeVisible()
  const run = page.getByTestId('web-run')
  await expect(run).toHaveCount(1) // the same card, carrying on
  await expect(run).toContainText('running')

  held.on = false
  await expect(run).toContainText('finished')
  await expect(run).toContainText('1 dataset')
  // The message box offers to tell the assistant; sent, the assistant has the whole chat and how the step ended.
  await expect(page.getByLabel('Message')).toHaveValue(/The scraper run sesn_1 finished while the page was reloaded; its files: rents\.csv/)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Reading the run.')).toBeVisible()
  const sent = JSON.stringify((seen[seen.length - 1] as { messages: unknown[] }).messages)
  expect(sent).toContain('Add rents per county')
  expect(sent).toContain('the page was reloaded while this step ran')
})

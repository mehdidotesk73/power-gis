// Shared steps for the UI tests. Elements are found by their stable test keys
// (data-testid) or by role and accessible name, never by layout.
import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

export const FIXTURES = new URL('../fixtures/', import.meta.url).pathname
/** The built-in CSVs (the ACS county tables are also the socioeconomic fixture's uploads). */
/** The default map's folder: its CSVs are the files a test uploads in place of built-ins. */
export const DATA = new URL('../../defaults/socioeconomic/', import.meta.url).pathname
const supabaseUrl = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321'
const supabaseKey = process.env.SUPABASE_TEST_KEY ?? ''
const run = Math.random().toString(36).slice(2, 7)

export interface User {
  name: string
  email: string
  password: string
}
/** A new account on the local stack (no confirmation email there). */
let made = 0
export async function account(name: string): Promise<User> {
  const user = { name, email: `${name}-${run}-${++made}@example.com`, password: 'test-password-1' }
  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await sb.auth.signUp({ email: user.email, password: user.password })
  if (error) throw new Error(`sign up ${user.email}: ${error.message}`)
  return user
}

export const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
export const LAPTOP: BrowserContextOptions = { viewport: { width: 1280, height: 860 } }

const open: BrowserContext[] = []
/** Closes the devices a test opened (call after each test, so pages don't keep running into the next). */
export async function closeDevices() {
  await Promise.all(open.splice(0).map((c) => c.close()))
}

/** A fresh device (its own storage), on the app, the first map drawn. */
export async function device(browser: Browser, options: BrowserContextOptions = LAPTOP): Promise<Page> {
  const context = await browser.newContext(options)
  open.push(context)
  // DuckDB extensions come from the test build itself (CI hosts them, as Netlify does); never from DuckDB's
  // servers, which some networks leave hanging (it would stall the app's worker). Refused at once instead.
  await context.route('https://extensions.duckdb.org/**', (route) => route.abort())
  const page = await context.newPage()
  page.on('dialog', (d) => void d.accept()) // confirm() prompts: yes
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`))
  await page.goto('/')
  await ready(page)
  return page
}

/** The page has settled: its workspace is loaded (empty on a first visit, or an opened one) and nothing is loading. */
export async function ready(page: Page) {
  await expect(page.locator('.page[data-ready="yes"]')).toBeVisible({ timeout: 180_000 })
}

export async function signIn(page: Page, user: User) {
  await page.getByRole('button', { name: /^Menu/ }).click()
  await page.getByRole('menuitem', { name: /Sign in/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Account' })
  await dialog.getByLabel('Email').fill(user.email)
  await dialog.getByLabel('Password').fill(user.password)
  await dialog.getByRole('button', { name: /^Sign in$/ }).click()
  await expect(page.getByRole('button', { name: 'Menu (signed in)' })).toBeVisible()
}

/** The Workspace panel opens by itself to report what an opened workspace lacks: close it. */
export async function closeWorkspacePanel(page: Page) {
  if (await page.getByRole('dialog', { name: 'Workspace' }).isVisible()) await page.getByRole('button', { name: /^Workspace/ }).click()
}

/** On phones the setup panels sit behind the Set up bar. */
export async function openSetup(page: Page) {
  const bar = page.getByRole('button', { name: /Set up/ })
  if (await bar.isVisible()) await bar.click()
}

export const node = (page: Page, kind: 'dataset' | 'transform' | 'viz', name: string) => page.locator(`[data-testid="node.${kind}"][data-name="${name}"]`)
export const card = (page: Page, kind: 'dataset' | 'transform' | 'viz' | 'story', name: string) => page.locator(`[data-testid="${kind}-card"][data-name="${name}"]`).first()

/** A card's hold menu (right-click: the same menu as touch-and-hold), then one of its actions. */
export async function cardAction(page: Page, target: Locator, action: string) {
  await target.click({ button: 'right' })
  await page.getByTestId(`menu.${action}`).click()
}

/** Loads a workspace file (Workspace → Load workspace file…). */
export async function loadWorkspaceFile(page: Page, file: string) {
  await openWorkspacePanel(page)
  await page.getByTestId('workspace.file-input').setInputFiles(file)
  await ready(page)
  await closeWorkspacePanel(page)
}

/** Opens the Workspace panel (unless a report already opened it). */
export async function openWorkspacePanel(page: Page) {
  if (!(await page.getByRole('dialog', { name: 'Workspace' }).isVisible())) await page.getByRole('button', { name: /^Workspace/ }).click()
}

/** The List view with one of its panels (Visualizations, Transforms, Datasets) open. */
export async function listPanel(page: Page, panel: 'Visualizations' | 'Transforms' | 'Datasets' | 'Stories') {
  await closeWorkspacePanel(page)
  await openSetup(page)
  await page.getByRole('button', { name: 'List', exact: true }).click()
  const details = page.locator('details', { has: page.locator('summary', { hasText: new RegExp(`^${panel}$`) }) })
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click()
  return details
}

/** Replaces a dataset this device doesn't have with a CSV file (its panel's Replace…). */
export async function replaceMissing(page: Page, name: string, file = `${DATA}${name}.csv`) {
  await listPanel(page, 'Datasets')
  const missing = page.locator(`[data-testid="missing-dataset"][data-name="${name}"]`)
  await missing.getByTestId('dataset.replace').click()
  await missing.getByTestId('add.source.upload').click()
  await missing.getByTestId('add.source.csv').check()
  await missing.getByTestId('add.csv-input').setInputFiles(file)
  await expect(missing).toHaveCount(0)
}

/** ↻ Run all stale, then each transform's card shows its rows. */
export async function runAllStale(page: Page, expected: [string, string][]) {
  await listPanel(page, 'Transforms')
  await page.getByTestId('run-all-stale').first().click()
  for (const [transform, rows] of expected) await expect(card(page, 'transform', transform), transform).toContainText(`${rows} rows`, { timeout: 120_000 })
}

/** The state-income workspace (tests/fixtures/state-income.powergis.json), loaded, its uploads given, run. */
export const STATE_INCOME: [string, string][] = [
  ['1 Clean county income', '3,222'],
  ['2 State income', '56'],
  ['3 State income map', '56'],
]
export async function setUpStateIncome(page: Page) {
  await loadWorkspaceFile(page, `${FIXTURES}state-income.powergis.json`)
  for (const name of ['county_income', 'county_education']) await replaceMissing(page, name)
  await runAllStale(page, STATE_INCOME)
}

/** Links datasets to the cloud from their cards (menu → Link to cloud → the review panel → Go ahead). */
export async function linkToCloud(page: Page, name: string) {
  await listPanel(page, 'Datasets')
  await cardAction(page, card(page, 'dataset', name), 'link')
  await page.getByTestId('batch.go').click()
  await page.getByTestId('batch.done').click()
  await expect(card(page, 'dataset', name).getByText(/^Cloud/)).toBeVisible()
}

/** Workspace → Save, until it says all changes are saved. */
export async function saveWorkspace(page: Page) {
  await openWorkspacePanel(page)
  await page.getByTestId('workspace.save').click()
  await expect(page.getByText(/All changes saved/)).toBeVisible()
  await closeWorkspacePanel(page)
}

/** Shares a dataset (its menu → Share…) with someone, as Can pull (read) or Can push (write). */
export async function share(page: Page, dataset: string, user: User, level: 'read' | 'write') {
  await listPanel(page, 'Datasets')
  await cardAction(page, card(page, 'dataset', dataset), 'share')
  const dialog = page.getByRole('dialog', { name: /^Share/ })
  await dialog.getByTestId('share.email').fill(user.email)
  await dialog.getByTestId('share.level').selectOption(level)
  await dialog.getByTestId('share.submit').click()
  await expect(dialog.locator(`[data-testid="share.member"][data-email="${user.email}"]`)).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
}

/** ＋ Dataset → Cloud → Add, for a cloud dataset someone shared (or one of yours). */
export async function addFromCloud(page: Page, name: string) {
  await listPanel(page, 'Datasets')
  const panel = page.locator('details', { has: page.locator('summary', { hasText: /^Datasets$/ }) })
  await panel.getByRole('button', { name: 'Dataset', exact: true }).click()
  await panel.getByTestId('add.source.library').click()
  await panel.getByTestId('add.source.cloud').check()
  await panel.locator('.stored li', { hasText: name }).getByRole('button', { name: 'Add' }).click()
  await expect(card(page, 'dataset', name)).toContainText('Cloud')
}

/** The sync panel for one dataset (its menu → Sync…); answers its line, to choose on. */
export async function openSync(page: Page, dataset: string) {
  await listPanel(page, 'Datasets')
  await cardAction(page, card(page, 'dataset', dataset), 'sync')
  return page.locator(`[data-testid="batch.item"][data-name="${dataset}"]`)
}

/** ＋ Transform in the graph: tap the inputs, Next, name the output, write the SQL (optionally into an existing dataset), Run. */
export async function newTransform(page: Page, o: { inputs: string[]; output: string; sql: string; writesTo?: string }) {
  await closeWorkspacePanel(page)
  await openSetup(page)
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await page.getByTestId('graph.add-transform').click()
  for (const input of o.inputs) await node(page, 'dataset', input).click()
  await page.getByTestId('graph.next').click()
  if (o.writesTo) await page.locator('[data-testid^="transform.writes-to."]').first().selectOption({ label: o.writesTo })
  else {
    await page.locator('[data-testid^="transform.output-name."]').first().fill(o.output)
    await page.locator('[data-testid^="transform.output-name."]').first().press('Tab')
  }
  const sql = page.locator('[data-testid^="transform.sql."]').first()
  await sql.fill(o.sql)
  await sql.press('Tab')
  await page.getByTestId('transform.run').click()
}

/** One line of the sync panel: choose an option, Go ahead, Done. */
export async function syncOne(page: Page, dataset: string, option: 'push' | 'pull') {
  const line = await openSync(page, dataset)
  await line.getByTestId(`batch.option.${option}`).click()
  await page.getByTestId('batch.go').click()
  await page.getByTestId('batch.done').click()
}

/** Reloads the page (the app checks cloud states on load) and waits for it to settle. */
export async function reload(page: Page) {
  await page.reload()
  await ready(page)
}

/** Runs SQL in a dataset's Explore window (its menu → Explore) and answers the result's rows, as the table shows them. */
export async function explore(page: Page, dataset: string, sql: string): Promise<string[][]> {
  await listPanel(page, 'Datasets')
  await cardAction(page, card(page, 'dataset', dataset), 'explore')
  const win = page.getByLabel(`Explore ${dataset}`)
  await win.getByLabel('SQL').fill(sql)
  await win.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(win.locator('.pager')).toBeVisible()
  const rows = await win.locator('table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim())))
  await win.getByRole('button', { name: 'Close' }).click()
  return rows
}

/** Workspace → Open the sample workspace (a fresh device starts empty), then Save it unless `save` is false. */
export async function openSample(page: Page, save = true) {
  await openWorkspacePanel(page)
  await page.getByTestId('workspace.sample').click()
  await ready(page)
  await expect(page.locator('[data-empty="yes"]')).toHaveCount(0)
  if (save) {
    await openWorkspacePanel(page)
    await page.getByTestId('workspace.save').click()
    await expect(page.getByText(/All changes saved/)).toBeVisible()
  }
  if (await page.getByRole('dialog', { name: 'Workspace' }).isVisible()) await page.getByRole('button', { name: /^Workspace/ }).click()
}

/** A small workspace (just the built-in US counties), so a test's graph stays small whatever the default map is. */
export async function startSmall(page: Page) {
  await loadWorkspaceFile(page, `${FIXTURES}counties-only.powergis.json`)
}

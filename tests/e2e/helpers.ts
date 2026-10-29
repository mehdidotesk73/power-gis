// Shared steps for the UI tests. Elements are found by their stable test keys
// (data-testid) or by role and accessible name, never by layout.
import { expect, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

export const FIXTURES = new URL('../fixtures/', import.meta.url).pathname
const supabaseUrl = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321'
const supabaseKey = process.env.SUPABASE_TEST_KEY ?? ''
const run = Math.random().toString(36).slice(2, 7)

export interface User {
  name: string
  email: string
  password: string
}
/** A new account on the local stack (no confirmation email there). */
export async function account(name: string): Promise<User> {
  const user = { name, email: `${name}-${run}@example.com`, password: 'test-password-1' }
  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await sb.auth.signUp({ email: user.email, password: user.password })
  if (error) throw new Error(`sign up ${user.email}: ${error.message}`)
  return user
}

export const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
export const LAPTOP: BrowserContextOptions = { viewport: { width: 1280, height: 860 } }

/** A fresh device (its own storage), on the app, the first map drawn. */
export async function device(browser: Browser, options: BrowserContextOptions = LAPTOP): Promise<Page> {
  const page = await (await browser.newContext(options)).newPage()
  page.on('dialog', (d) => void d.accept()) // confirm() prompts: yes
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`))
  await page.goto('/')
  await ready(page)
  return page
}

/** The page has settled: no loading note (the default map, an opened workspace). */
export async function ready(page: Page) {
  await page.waitForFunction(() => document.body.innerText.includes('Search within') && !/Preparing the default map|Opening |Loading data…/.test(document.body.innerText), null, { timeout: 120_000 })
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
export const card = (page: Page, kind: 'dataset' | 'transform' | 'viz', name: string) => page.locator(`[data-testid="${kind}-card"][data-name="${name}"]`).first()

/** A card's hold menu (right-click: the same menu as touch-and-hold), then one of its actions. */
export async function cardAction(page: Page, target: Locator, action: string) {
  await target.click({ button: 'right' })
  await page.getByTestId(`menu.${action}`).click()
}

/** Loads a workspace file (Workspace → Load workspace file…). */
export async function loadWorkspaceFile(page: Page, file: string) {
  await page.getByRole('button', { name: /^Workspace/ }).click()
  await page.getByTestId('workspace.file-input').setInputFiles(file)
  await ready(page)
  await page.getByRole('button', { name: /^Workspace/ }).click() // closes the panel
}

/** The List view with one of its panels (Visualizations, Transforms, Datasets) open. */
export async function listPanel(page: Page, panel: 'Visualizations' | 'Transforms' | 'Datasets') {
  await closeWorkspacePanel(page)
  await openSetup(page)
  await page.getByRole('button', { name: 'List', exact: true }).click()
  const details = page.locator('details', { has: page.locator('summary', { hasText: new RegExp(`^${panel}$`) }) })
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click()
  return details
}

/** Replaces a dataset this device doesn't have with a CSV file (its panel's Replace…). */
export async function replaceMissing(page: Page, name: string, file = `${FIXTURES}${name}.csv`) {
  await listPanel(page, 'Datasets')
  const missing = page.locator(`[data-testid="missing-dataset"][data-name="${name}"]`)
  await missing.getByTestId('dataset.replace').click()
  await missing.getByTestId('add.source.csv').click()
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
  await page.getByRole('button', { name: /^Workspace/ }).click()
  await page.getByTestId('workspace.save').click()
  await expect(page.getByText(/All changes saved/)).toBeVisible()
  await page.getByRole('button', { name: /^Workspace/ }).click()
}

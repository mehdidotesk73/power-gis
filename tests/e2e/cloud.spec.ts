// Two people and several devices against the local Supabase stack, through the
// UI: each device is its own browser context (its own storage), as a phone
// and a laptop are. Data: the state-income workspace (tests/fixtures).
import { expect, test } from '@playwright/test'
import { closeDevices, account, addFromCloud, card, cardAction, device, explore, LAPTOP, linkToCloud, listPanel, newTransform, node, openSync, PHONE, ready, reload, saveWorkspace, setUpStateIncome, share, signIn, startSmall, syncOne } from './helpers'

test.afterEach(closeDevices)

test('one person, two devices: what is linked arrives, what is only on the first device is named as missing', async ({ browser }) => {
  const anna = await account('anna')
  const laptop = await device(browser, LAPTOP)
  await signIn(laptop, anna)
  await setUpStateIncome(laptop)
  // One upload and one output go to the cloud; the other upload stays on the laptop.
  await linkToCloud(laptop, 'county_income')
  await linkToCloud(laptop, 'State income')
  await saveWorkspace(laptop)

  // The phone: signing in opens the account's workspace.
  const phone = await device(browser, PHONE)
  await signIn(phone, anna)
  await expect(phone.getByText(/Opened your workspace from your account/)).toBeVisible({ timeout: 120_000 })
  await expect(phone.getByRole('dialog', { name: 'Workspace' })).toContainText('"county_education" (3,222 rows)')
  await ready(phone)
  await listPanel(phone, 'Datasets')
  await expect(card(phone, 'dataset', 'county_income')).toContainText('Cloud')
  await expect(card(phone, 'dataset', 'State income')).toContainText('Cloud')
  await expect(card(phone, 'dataset', 'State income')).toContainText('56 rows')
  // Only on the laptop: named, with why.
  await expect(phone.locator('[data-testid="missing-dataset"][data-name="county_education"]')).toContainText('another device')
  // Built-ins are made here; the transform whose input arrived made its output here too.
  await expect(card(phone, 'dataset', 'US states')).toContainText('56 rows')
  await expect(card(phone, 'dataset', 'Clean county income')).toContainText('3,222 rows')
  await phone.screenshot({ path: 'test-results/cloud-1-phone.png' })
})

test("shared to read: the reader builds on it, pulls the owner's changes, and can't push or share", async ({ browser }) => {
  const [anna, ben] = await Promise.all([account('anna'), account('ben')])
  const a = await device(browser, LAPTOP)
  await signIn(a, anna)
  await setUpStateIncome(a)
  await linkToCloud(a, 'State income')
  await share(a, 'State income', ben, 'read')

  const b = await device(browser, LAPTOP)
  await signIn(b, ben)
  await startSmall(b)
  await addFromCloud(b, 'State income')
  await expect(card(b, 'dataset', 'State income')).toContainText('56 rows')

  // Ben's own transform reads it: ＋ Transform, tap it, Next, SQL, Run.
  await b.getByRole('button', { name: 'Graph', exact: true }).click()
  await b.getByTestId('graph.add-transform').click()
  await node(b, 'dataset', 'State income').click()
  await b.getByTestId('graph.next').click()
  await b.locator('[data-testid^="transform.output-name."]').first().fill('Top 10 states')
  await b.locator('[data-testid^="transform.output-name."]').first().press('Tab')
  await b.locator('[data-testid^="transform.sql."]').first().fill('SELECT state, avg_median_hh_income FROM state_income ORDER BY avg_median_hh_income DESC LIMIT 10')
  await b.locator('[data-testid^="transform.sql."]').first().press('Tab')
  await b.getByTestId('transform.run').click()
  await expect(node(b, 'dataset', 'Top 10 states')).toHaveAttribute('title', /10 rows/)
  await b.getByTestId('transform.done').click()

  // Reading only: Push is off in the sync panel, and the share form is off.
  const line = await openSync(b, 'State income')
  await expect(line.getByTestId('batch.option.push')).toBeDisabled()
  await b.getByRole('button', { name: 'Cancel' }).click()
  await cardAction(b, card(b, 'dataset', 'State income'), 'share')
  await expect(b.getByTestId('share.email')).toBeDisabled()
  await b.getByRole('dialog', { name: /^Share/ }).getByRole('button', { name: 'Close' }).click()

  // Anna runs her transform again (↑ on her side) and pushes: Ben sees ↓ and pulls.
  await listPanel(a, 'Transforms')
  await cardAction(a, card(a, 'transform', '2 State income'), 'run')
  await listPanel(a, 'Datasets')
  await expect(card(a, 'dataset', 'State income')).toContainText('Cloud ↑')
  const aLine = await openSync(a, 'State income')
  await aLine.getByTestId('batch.option.push').click()
  await a.getByTestId('batch.go').click()
  await a.getByTestId('batch.done').click()
  await expect(card(a, 'dataset', 'State income')).not.toContainText('↑')

  await b.reload()
  await ready(b)
  await listPanel(b, 'Datasets')
  await expect(card(b, 'dataset', 'State income')).toContainText('Cloud ↓')
  const bLine = await openSync(b, 'State income')
  await bLine.getByTestId('batch.option.pull').click()
  await b.getByTestId('batch.go').click()
  await b.getByTestId('batch.done').click()
  await expect(card(b, 'dataset', 'State income')).not.toContainText('↓')
})

test('two writers: both compute the state averages and push; the second gets ↑↓ and chooses', async ({ browser }) => {
  const [anna, ben] = await Promise.all([account('anna'), account('ben')])
  const a = await device(browser, LAPTOP)
  await signIn(a, anna)
  await setUpStateIncome(a)
  await linkToCloud(a, 'county_income')
  await linkToCloud(a, 'State income')
  await share(a, 'county_income', ben, 'read')
  await share(a, 'State income', ben, 'write')

  // Ben: the shared county data and the state dataset; he computes the averages himself from the built-in
  // counties and writes them into his copy of the state dataset.
  const b = await device(browser, LAPTOP)
  await signIn(b, ben)
  await startSmall(b)
  await addFromCloud(b, 'county_income')
  await addFromCloud(b, 'State income')
  await newTransform(b, {
    inputs: ['US counties', 'county_income'],
    output: 'State income',
    writesTo: 'State income',
    sql:
      'SELECT c.state_fips, any_value(c.state) AS state, count(i.median_hh_income) AS counties,\n' +
      '  round(avg(CASE WHEN i.median_hh_income > 0 THEN i.median_hh_income END), 0) AS avg_median_hh_income,\n' +
      "  'ben' AS computed_by\n" +
      'FROM us_counties c LEFT JOIN county_income i ON i.GEOID = c.fips GROUP BY c.state_fips',
  })
  await expect(node(b, 'dataset', 'State income')).toHaveAttribute('title', /56 rows/)
  await b.getByTestId('transform.done').click()
  await listPanel(b, 'Datasets')
  await expect(card(b, 'dataset', 'State income')).toContainText('Cloud ↑')

  // Anna runs hers again and pushes first.
  await listPanel(a, 'Transforms')
  await cardAction(a, card(a, 'transform', '2 State income'), 'run')
  await listPanel(a, 'Datasets')
  await expect(card(a, 'dataset', 'State income')).toContainText('Cloud ↑')
  await syncOne(a, 'State income', 'push')

  // Ben: changed here and in the cloud. His line starts on Skip; he pushes over Anna's version.
  await reload(b)
  await listPanel(b, 'Datasets')
  await expect(card(b, 'dataset', 'State income')).toContainText('Cloud ↑↓')
  const line = await openSync(b, 'State income')
  await expect(line.getByTestId('batch.option.skip')).toHaveClass(/on/)
  await line.getByTestId('batch.option.push').click()
  await b.getByTestId('batch.go').click()
  await expect(line).toContainText(/Done/)
  await b.getByTestId('batch.done').click()
  await expect(card(b, 'dataset', 'State income')).not.toContainText('↑')

  // Anna: ↓, pulls, and has Ben's version (his extra column).
  await reload(a)
  await listPanel(a, 'Datasets')
  await expect(card(a, 'dataset', 'State income')).toContainText('Cloud ↓')
  await syncOne(a, 'State income', 'pull')
  await expect(card(a, 'dataset', 'State income')).toContainText('5 columns')
})

test('access changes: lowered to read, the push is off; leaving keeps a local copy', async ({ browser }) => {
  const [anna, ben] = await Promise.all([account('anna'), account('ben')])
  const a = await device(browser, LAPTOP)
  await signIn(a, anna)
  await setUpStateIncome(a)
  await linkToCloud(a, 'State income')
  await share(a, 'State income', ben, 'write')

  const b = await device(browser, PHONE)
  await signIn(b, ben)
  await addFromCloud(b, 'State income')
  // Ben changes his copy (a rename, saved): ↑, his to push while he can write.
  await cardAction(b, card(b, 'dataset', 'State income'), 'edit')
  await b.locator('[data-testid="dataset-editor"][data-name="State income"]').getByLabel('Name').fill('State income (Ben)')
  await b.locator('[data-testid="dataset-editor"][data-name="State income"]').getByLabel('Name').press('Tab')
  await saveWorkspace(b)
  await listPanel(b, 'Datasets')
  await expect(card(b, 'dataset', 'State income (Ben)')).toContainText('Cloud ↑')
  let line = await openSync(b, 'State income (Ben)')
  await expect(line.getByTestId('batch.option.push')).toBeEnabled()
  await b.getByRole('button', { name: 'Cancel' }).click()

  // Anna lowers Ben to Can pull: his push is off now, with the reason.
  await listPanel(a, 'Datasets')
  await cardAction(a, card(a, 'dataset', 'State income'), 'share')
  const dialog = a.getByRole('dialog', { name: /^Share/ })
  await dialog.locator(`[data-testid="share.member"][data-email="${ben.email}"]`).getByRole('combobox').selectOption('read')
  await expect(dialog.getByText(/can only pull now/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()

  await reload(b)
  line = await openSync(b, 'State income (Ben)')
  await expect(line.getByTestId('batch.option.push')).toBeDisabled()
  await expect(line).toContainText('you can only read')
  await b.getByRole('button', { name: 'Cancel' }).click()

  // Ben leaves: his copy stays, local only, and the cloud no longer lists it for him.
  await cardAction(b, card(b, 'dataset', 'State income (Ben)'), 'share')
  await b.getByRole('dialog', { name: /^Share/ }).getByRole('button', { name: 'Leave' }).click()
  await expect(card(b, 'dataset', 'State income (Ben)')).toContainText('Local')
  const panel = b.locator('details', { has: b.locator('summary', { hasText: /^Datasets$/ }) })
  await panel.getByRole('button', { name: 'Dataset', exact: true }).click()
  await panel.getByTestId('add.source.cloud').click()
  await expect(panel.locator('.stored li', { hasText: 'State income' })).toHaveCount(0)
})

test('signed out: everything local works; the cloud asks to sign in', async ({ browser }) => {
  const page = await device(browser, PHONE)
  await setUpStateIncome(page)
  // The numbers, read through Explore, match the same SQL run outside the app (DuckDB in Node over the same
  // files). Connecticut has none: the ACS data uses its new planning regions, the shapes its old counties.
  expect(await explore(page, 'State income', "SELECT state, counties, avg_median_hh_income FROM state_income WHERE state IN ('CA', 'CT', 'DE', 'PR', 'TX') ORDER BY state")).toEqual([
    ['CA', '58', '89387'],
    ['CT', '0', ''],
    ['DE', '3', '82380'],
    ['PR', '78', '24983'],
    ['TX', '254', '66482'],
  ])
  await listPanel(page, 'Datasets')
  await cardAction(page, card(page, 'dataset', 'county_income'), 'link')
  await expect(card(page, 'dataset', 'county_income')).toContainText(/Sign in/)
  const panel = page.locator('details', { has: page.locator('summary', { hasText: /^Datasets$/ }) })
  await panel.getByRole('button', { name: 'Dataset', exact: true }).click()
  await expect(panel.getByTestId('add.source.cloud')).toHaveCount(0)
})

test('a new device signed in while its first map loads opens the account workspace, and never replaces it', async ({ browser }) => {
  const ben = await account('ben')
  const laptop = await device(browser, LAPTOP)
  await signIn(laptop, ben)
  await startSmall(laptop)
  await saveWorkspace(laptop)

  // A fresh device (a private window): sign in at once, before the default map has finished loading.
  const context = await browser.newContext(PHONE)
  await context.route('https://extensions.duckdb.org/**', (route) => route.abort())
  const phone = await context.newPage()
  phone.on('dialog', (d) => void d.accept())
  await phone.goto('/')
  await signIn(phone, ben)
  await ready(phone)
  await expect(phone.getByText(/Opened your workspace from your account/)).toBeVisible({ timeout: 120_000 })
  await expect(node(phone, 'dataset', 'County income (ACS)')).toHaveCount(0)
  await context.close()

  // The account still holds the laptop's workspace: a reload there opens nothing new over it.
  await reload(laptop)
  await expect(laptop.getByText(/Opened your workspace from your account/)).toHaveCount(0)
  await expect(node(laptop, 'dataset', 'County income (ACS)')).toHaveCount(0)
})

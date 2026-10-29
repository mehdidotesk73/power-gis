// The socioeconomic pipeline: built-in county and state shapes and six ACS
// county tables, ten transforms in five stages, twelve visualizations. It is
// the default map (public/data/default.powergis.json), and also a workspace
// file whose tables are uploads (tests/fixtures/socioeconomic.powergis.json).
// Its spatial step (1e, land area) needs DuckDB's spatial extension, which the
// CI build hosts with the app.
import { expect, test, type Page } from '@playwright/test'
import { closeDevices, card, DATA, device, explore, FIXTURES, listPanel, loadWorkspaceFile, node } from './helpers'

/** Each transform's output and the rows it must have (as the app showed them on the user's phone). */
const OUTPUTS: [string, string][] = [
  ['Clean county income', '3,222'],
  ['Clean county education', '3,222'],
  ['Clean county health insurance', '3,222'],
  ['Clean county home value', '3,222'],
  ['County shapes and land area', '3,231'],
  ['Counties with income and education', '3,231'],
  ['Counties with all factors', '3,231'],
  ['County metrics and scores', '3,231'],
  ['State averages', '56'],
  ['State map layer', '56'],
]

/** Every output dataset has its rows (they're made while the workspace opens, or by Run all stale). */
async function expectOutputs(page: Page) {
  await listPanel(page, 'Datasets')
  for (const [output, rows] of OUTPUTS) await expect(card(page, 'dataset', output), output).toContainText(`${rows} rows`, { timeout: 180_000 })
}

test.afterEach(closeDevices)

test('the default map is the socioeconomic pipeline: every output made, the numbers hold', async ({ browser }) => {
  const page = await device(browser) // a fresh device opens the default map
  for (const table of ['County income (ACS)', 'County education (ACS B15003)', 'US counties', 'US states']) {
    await listPanel(page, 'Datasets')
    await expect(card(page, 'dataset', table), table).toContainText('Built-in')
  }
  await expectOutputs(page)

  // What must hold whatever the exact numbers: every county counted once, 56 states and territories, scores
  // within 0–100, and Connecticut unscored (ACS reports its new planning regions, the shapes its old counties).
  expect(await explore(page, 'State averages', 'SELECT sum(counties) AS counties, count(*) AS states, count(*) FILTER (WHERE socio_score < 0 OR socio_score > 100) AS out_of_range FROM state_averages')).toEqual([['3231', '56', '0']])
  expect(await explore(page, 'State averages', "SELECT counties_scored FROM state_averages WHERE state_abbr = 'CT'")).toEqual([['0']])
  expect(await explore(page, 'County metrics and scores', 'SELECT count(*) FILTER (WHERE socio_score < 0 OR socio_score > 100) FROM county_metrics_and_scores')).toEqual([['0']])

  // A sample for the user to check against the app (printed in CI's log; locked in once confirmed).
  const counties = await explore(page, 'County metrics and scores', "SELECT fips, name, median_hh_income, bachelor_pct, uninsured_pct, price_to_income, socio_score FROM county_metrics_and_scores WHERE fips IN ('01001', '06037', '17031', '48201', '36061') ORDER BY fips")
  const states = await explore(page, 'State averages', "SELECT state_abbr, counties, counties_scored, avg_median_hh_income, socio_score FROM state_averages WHERE state_abbr IN ('CA', 'CT', 'NY', 'TX', 'WY') ORDER BY state_abbr")
  console.log(`[for sign-off] counties:\n${counties.map((r) => r.join(' | ')).join('\n')}\n[for sign-off] states:\n${states.map((r) => r.join(' | ')).join('\n')}`)
})

const UPLOADS = ['county_income', 'county_education', 'county_health_insurance', 'county_home_value', 'county_rent', 'county_columns']

test('the same pipeline from a file with uploads: missing on a fresh device, replaced, run', async ({ browser }) => {
  const page = await device(browser)
  await loadWorkspaceFile(page, `${FIXTURES}socioeconomic.powergis.json`)
  // Its uploads aren't on this device: each is a missing root in the graph.
  for (const name of UPLOADS) await expect(node(page, 'dataset', name)).toHaveAttribute('data-problem', 'missing')

  // Replace each with its file, in the list: a missing dataset shows its panel with Replace….
  await listPanel(page, 'Datasets')
  for (const name of UPLOADS) {
    const missing = page.locator(`[data-testid="missing-dataset"][data-name="${name}"]`)
    await missing.getByTestId('dataset.replace').click()
    await missing.getByTestId('add.source.csv').click()
    await missing.getByTestId('add.csv-input').setInputFiles(`${DATA}${name}.csv`)
    await expect(missing).toHaveCount(0)
  }

  // Run everything (↻ Run all stale also makes outputs this device doesn't have yet), in dependency order.
  await listPanel(page, 'Transforms')
  await page.getByTestId('run-all-stale').first().click()
  await expectOutputs(page)
})

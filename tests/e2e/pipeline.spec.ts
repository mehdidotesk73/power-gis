// The socioeconomic pipeline: built-in county and state shapes and six ACS
// county tables, ten transforms in five stages, twelve visualizations. It is
// the default map (defaults/socioeconomic/workspace.powergis.json), and also a workspace
// file whose tables are uploads (tests/fixtures/socioeconomic.powergis.json).
// Its spatial step (1e, land area) needs DuckDB's spatial extension, which the
// CI build hosts with the app.
import { expect, test, type Page } from '@playwright/test'
import { closeDevices, card, DATA, device, explore, FIXTURES, listPanel, loadWorkspaceFile, node, openSample } from './helpers'

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

/** Counties: fips, median household income, bachelor's %, uninsured %, home price ÷ income, socio score. */
const COUNTIES = [
  ['01001', '72481', '29.14', '7.28', '2.86', '63.0'],
  ['06037', '90112', '36.01', '8.21', '9.26', '56.0'],
  ['17031', '83498', '42.72', '8.85', '3.89', '60.5'],
  ['36061', '103931', '64.19', '4.22', '10.49', '71.2'],
  ['48201', '74983', '34.24', '20.90', '3.69', '46.8'],
]
/** States: counties, counties scored, average median household income, socio score (Connecticut unscored). */
const STATES = [
  ['CA', '58', '58', '81121', '48.9'],
  ['CT', '8', '0', '-', '-'],
  ['NY', '62', '62', '74287', '69.4'],
  ['TX', '254', '250', '64940', '40.4'],
  ['WY', '23', '23', '75535', '45.8'],
]

test.afterEach(closeDevices)

test('the sample workspace is the socioeconomic pipeline: every output made, the numbers hold', async ({ browser }) => {
  const page = await device(browser) // a fresh device starts empty
  await expect(page.getByTestId('map.empty')).toBeVisible()
  await openSample(page, false)
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

  // A sample the user checked against the app (signed off 2026-10-29). Formatted in the SQL, so the cells compare as text
  // (as DOUBLE: DuckDB's printf refuses %f for an integer column).
  const counties = await explore(page, 'County metrics and scores', `SELECT fips, name, printf('%.0f', median_hh_income::DOUBLE), printf('%.2f', bachelor_pct::DOUBLE), printf('%.2f', uninsured_pct::DOUBLE),
    printf('%.2f', price_to_income::DOUBLE), printf('%.1f', socio_score::DOUBLE) FROM county_metrics_and_scores WHERE fips IN ('01001', '06037', '17031', '48201', '36061') ORDER BY fips`)
  expect(counties.map((r) => [r[0], ...r.slice(2)])).toEqual(COUNTIES)
  const states = await explore(page, 'State averages', `SELECT state_abbr, CAST(counties AS VARCHAR), CAST(counties_scored AS VARCHAR), coalesce(printf('%.0f', avg_median_hh_income::DOUBLE), '-'),
    coalesce(printf('%.1f', socio_score::DOUBLE), '-') FROM state_averages WHERE state_abbr IN ('CA', 'CT', 'NY', 'TX', 'WY') ORDER BY state_abbr`)
  expect(states).toEqual(STATES)
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

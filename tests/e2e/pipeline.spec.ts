// The socioeconomic workspace (tests/fixtures): built-in county and state
// shapes, six uploaded CSVs, ten transforms in five stages and twelve
// visualizations. Loaded from its file on a fresh device, its uploads are
// missing; each is replaced with its CSV through the dataset panel, then the
// transforms run, and every output must have the expected rows.
import { expect, test } from '@playwright/test'
import { card, device, explore, FIXTURES, loadWorkspaceFile, node } from './helpers'

/** Each transform and the rows its output must have (as the app showed them on the user's phone). */
const OUTPUTS: [string, string][] = [
  ['1a Clean county income', '3,222'],
  ['1b Clean county education', '3,222'],
  ['1c Clean county health insurance', '3,222'],
  ['1d Clean county home value', '3,222'],
  ['1e County shapes and land area', '3,231'],
  ['2a Join shapes with income and education', '3,231'],
  ['2b Join insurance and home value', '3,231'],
  ['3a County metrics and scores', '3,231'],
  ['4a State averages (area-weighted)', '56'],
  ['5 State map layer', '56'],
]
const UPLOADS = ['county_income', 'county_education', 'county_health_insurance', 'county_home_value', 'county_rent', 'county_columns']

test('the socioeconomic workspace: load, replace its uploads, run, check every output', async ({ browser }) => {
  const page = await device(browser)
  await loadWorkspaceFile(page, `${FIXTURES}socioeconomic.powergis.json`)
  await page.screenshot({ path: 'test-results/pipeline-1-loaded.png' })

  // Its uploads aren't on this device: each is a missing root in the graph.
  for (const name of UPLOADS) await expect(node(page, 'dataset', name)).toHaveAttribute('data-problem', 'missing')

  // Replace each with its file, in the list: a missing dataset shows its panel with Replace….
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await page.locator('summary', { hasText: /^Datasets$/ }).click()
  for (const name of UPLOADS) {
    const missing = page.locator(`[data-testid="missing-dataset"][data-name="${name}"]`)
    await missing.getByTestId('dataset.replace').click()
    await missing.getByTestId('add.source.csv').click()
    await missing.getByTestId('add.csv-input').setInputFiles(`${FIXTURES}${name}.csv`)
    await expect(missing).toHaveCount(0)
  }
  await page.screenshot({ path: 'test-results/pipeline-2-replaced.png' })

  // Run everything (↻ Run all stale also makes outputs this device doesn't have yet), in dependency order.
  await page.locator('summary', { hasText: /^Transforms$/ }).click()
  await page.getByTestId('run-all-stale').first().click()
  for (const [transform, rows] of OUTPUTS) await expect(card(page, 'transform', transform), transform).toContainText(`${rows} rows`, { timeout: 120_000 })
  await expect(page.getByTestId('run-all-stale')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/pipeline-3-ran.png' })

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

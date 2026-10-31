// Stories: a workspace file carrying a story opens it in Stories; the story shows its scenes, a sample
// (marked when its data changed since the story was written), charts drawn from their SQL, and a map
// drawn off screen from its settings. ＋ Story picks visualizations and, with no API key yet, asks for one.
import { expect, test } from '@playwright/test'
import { card, closeDevices, device, FIXTURES, listPanel, loadWorkspaceFile, replaceMissing, runAllStale, STATE_INCOME } from './helpers'

test.afterEach(closeDevices)

test('a story opens: scenes, a sample, charts and a map, all drawn from their code', async ({ browser }) => {
  const page = await device(browser)
  await loadWorkspaceFile(page, `${FIXTURES}state-income-story.powergis.json`)
  for (const name of ['county_income', 'county_education']) await replaceMissing(page, name)
  await runAllStale(page, STATE_INCOME)

  const panel = await listPanel(page, 'Stories')
  const story = card(page, 'story', 'How state income is mapped')
  await expect(story).toContainText('3 scenes')
  await story.dblclick()
  const view = page.getByTestId('story.view')
  await expect(view.getByTestId('story.scene')).toHaveCount(3)
  await expect(view.getByTestId('story.scene').first()).toContainText('County incomes')

  // The sample reads the replaced dataset (the story followed Replace…), and its old snapshot no longer matches.
  const sample = view.locator('[data-testid="story.figure"][data-kind="sample"]')
  await expect(sample.locator('tbody tr')).toHaveCount(8)
  await expect(sample.getByTestId('story.changed')).toBeVisible()
  // Charts are drawn from their SQL: ten bars, twelve bins.
  const charts = view.locator('[data-testid="story.figure"][data-kind="chart"]')
  await expect(charts.first().locator('rect.bar')).toHaveCount(10)
  await expect(charts.nth(1).locator('rect.bar')).toHaveCount(12)
  // The map is drawn off screen, then shown as a picture; the page keeps its one map.
  const figure = view.locator('[data-testid="story.figure"][data-kind="map"]')
  await figure.scrollIntoViewIfNeeded()
  await expect(figure.locator('img')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(1)

  // Edit a narrative: kept in the draft.
  await view.getByTestId('story.edit').click()
  await view.locator('textarea').first().fill('Each row is a county and its median income.')
  await view.getByTestId('story.save').click()
  await expect(view.getByTestId('story.scene').first()).toContainText('Each row is a county and its median income.')

  // ＋ Story: pick the visualizations; without an API key the assistant asks for one.
  await panel.getByTestId('story.add').click()
  await panel.getByTestId('story.pick.State average household income ($)').check()
  await panel.getByTestId('story.tell').click()
  await expect(page.getByText('Add your Anthropic API key')).toBeVisible()
})

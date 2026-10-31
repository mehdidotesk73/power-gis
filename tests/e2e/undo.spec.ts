// Graph multi-select, Delete (out of the workspace, never the data) and undo / redo; copying the map
// as a picture.
import { expect, test, type Page } from '@playwright/test'
import { card, cardAction, closeDevices, device, listPanel, setUpStateIncome } from './helpers'

test.afterEach(closeDevices)

const node = (page: Page, kind: 'dataset' | 'transform' | 'viz', name: string) => page.locator(`[data-testid="node.${kind}"][data-name="${name}"]`)
const VIZ = 'State average household income ($)'
const MAP_STEP = '3 State income map'

test('picks several graph nodes, deletes them, and brings them back with undo', async ({ browser }) => {
  const page = await device(browser)
  await setUpStateIncome(page)
  await page.getByRole('button', { name: 'Graph', exact: true }).click()

  // Ctrl/⌘-click picks; Delete takes them out of the workspace.
  await node(page, 'viz', VIZ).click({ modifiers: ['ControlOrMeta'] })
  await node(page, 'transform', MAP_STEP).click({ modifiers: ['ControlOrMeta'] })
  // The tools open in the graph's corner while something is picked.
  await expect(page.getByTestId('tools.delete')).toHaveText('Delete 2')
  await page.keyboard.press('Delete')
  await expect(node(page, 'viz', VIZ)).toHaveCount(0)
  await expect(node(page, 'transform', MAP_STEP)).toHaveCount(0)
  await expect(page.getByText(/Removed 2 from the workspace/)).toBeVisible()

  // Undo brings both back; redo removes them again; the ↶ button undoes too.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(node(page, 'viz', VIZ)).toHaveCount(1)
  await expect(node(page, 'transform', MAP_STEP)).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(node(page, 'viz', VIZ)).toHaveCount(0)
  await page.getByTestId('tools.open').click()
  await page.getByTestId('undo').click()
  await expect(node(page, 'viz', VIZ)).toHaveCount(1)

  // Select (for phones), then Delete: a dataset a remaining transform still reads stays, with why.
  await page.getByTestId('tools.select').click()
  await node(page, 'dataset', 'county_income').first().click()
  await page.getByTestId('tools.delete').click()
  await expect(page.getByText(/Kept “county_income”: transform "1 Clean county income" reads it/)).toBeVisible()
  await expect(node(page, 'dataset', 'county_income')).toHaveCount(1)
})

test('the list view picks several items of any kind, deletes them, and undo brings them back', async ({ browser }) => {
  const page = await device(browser)
  await setUpStateIncome(page)
  await page.getByRole('button', { name: 'List', exact: true }).click()

  // Ctrl/⌘-click a visualization and a transform; Delete takes both out.
  await listPanel(page, 'Visualizations')
  await card(page, 'viz', VIZ).click({ modifiers: ['ControlOrMeta'] })
  await listPanel(page, 'Transforms')
  await card(page, 'transform', MAP_STEP).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('tools.delete')).toHaveText('Delete 2')
  await page.keyboard.press('Delete')
  await expect(page.getByText(/Removed 2 from the workspace/)).toBeVisible()
  await expect(page.locator(`[data-testid="viz-card"][data-name="${VIZ}"]`)).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator(`[data-testid="viz-card"][data-name="${VIZ}"]`)).toHaveCount(1)

  // On a phone: the tools' Select, then taps; Delete, then ↷ / ↶ in the same menu (the bar is still open, its note
  // saying what the last Delete did).
  await expect(page.getByTestId('tools.select')).toBeVisible()
  await page.getByTestId('tools.select').click()
  await listPanel(page, 'Transforms')
  await card(page, 'transform', MAP_STEP).click()
  await expect(card(page, 'transform', MAP_STEP)).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('tools.delete').click()
  await expect(page.locator(`[data-testid="transform-card"][data-name="${MAP_STEP}"]`)).toHaveCount(0)
  await page.getByTestId('undo').click()
  await expect(page.locator(`[data-testid="transform-card"][data-name="${MAP_STEP}"]`)).toHaveCount(1)
  await page.getByTestId('tools.close').click()
  await expect(page.getByTestId('tools.open')).toBeVisible()
})

test('copies the map, with its legend, as a picture', async ({ browser, baseURL }) => {
  const page = await device(browser)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
  await setUpStateIncome(page)
  await page.getByRole('button', { name: 'Back to the map' }).click()
  await page.getByTestId('map.copy-image').click()
  await expect(page.getByText('Copied ✓')).toBeVisible()
  const size = await page.evaluate(async () => {
    const blob = await (await navigator.clipboard.read())[0].getType('image/png')
    const img = await createImageBitmap(blob)
    return { w: img.width, h: img.height }
  })
  const box = await page.locator('.maplibregl-canvas').first().evaluate((c) => ({ w: (c as HTMLCanvasElement).width, h: (c as HTMLCanvasElement).height }))
  expect(size).toEqual(box)
})

test('copies one visualization alone, drawn off screen, without touching the map', async ({ browser, baseURL }) => {
  const page = await device(browser)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
  await setUpStateIncome(page)
  await listPanel(page, 'Visualizations')
  await cardAction(page, card(page, 'viz', 'State average household income ($)'), 'image')
  await expect(page.getByTestId('page.note')).toHaveText('Copied “State average household income ($)” ✓', { timeout: 30000 })
  // A map of its own (about 720 × 480 page pixels), gone again: only the page's map is left.
  const size = await page.evaluate(async () => {
    const blob = await (await navigator.clipboard.read())[0].getType('image/png')
    const img = await createImageBitmap(blob)
    return { w: img.width, h: img.height }
  })
  const dpr = await page.evaluate(() => devicePixelRatio)
  // (less the map frame's 1px border)
  expect(Math.abs(size.w - 720 * dpr)).toBeLessThanOrEqual(2 * dpr)
  expect(Math.abs(size.h - 480 * dpr)).toBeLessThanOrEqual(2 * dpr)
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(1)
})

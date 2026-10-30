// Graph multi-select, Delete (out of the workspace, never the data) and undo / redo; copying the map
// as a picture.
import { expect, test, type Page } from '@playwright/test'
import { closeDevices, device, setUpStateIncome } from './helpers'

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
  await expect(page.getByTestId('graph.picks')).toContainText('2 selected')
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
  await page.getByTestId('undo').click()
  await expect(node(page, 'viz', VIZ)).toHaveCount(1)

  // Select (for phones), then Delete: a dataset a remaining transform still reads stays, with why.
  await page.getByTestId('graph.select').click()
  await node(page, 'dataset', 'county_income').first().click()
  await page.getByTestId('graph.delete').click()
  await expect(page.getByText(/Kept “county_income”: transform "1 Clean county income" reads it/)).toBeVisible()
  await expect(node(page, 'dataset', 'county_income')).toHaveCount(1)
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

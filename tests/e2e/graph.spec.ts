// The graph: Copy as image puts a PNG of what the graph's window shows (as panned and zoomed) on the
// clipboard.
import { expect, test } from '@playwright/test'
import { closeDevices, closeWorkspacePanel, device, startSmall } from './helpers'

test.afterEach(closeDevices)

test('copies what the graph shows as a picture', async ({ browser, baseURL }) => {
  const page = await device(browser)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
  await startSmall(page)
  await closeWorkspacePanel(page)
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await page.getByTestId('graph.copy-image').first().click()
  await expect(page.getByText('Copied ✓')).toBeVisible()
  // The clipboard holds a PNG the size of the graph's window, at twice the pixels or more.
  const size = await page.evaluate(async () => {
    const blob = await (await navigator.clipboard.read())[0].getType('image/png')
    const img = await createImageBitmap(blob)
    return { w: img.width, h: img.height }
  })
  const box = await page.locator('.dag .scroll').first().evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }))
  expect(size.w).toBeGreaterThanOrEqual(box.w * 2 - 1)
  expect(size.h).toBeGreaterThanOrEqual(box.h * 2 - 1)
  expect(size.w / size.h).toBeCloseTo(box.w / box.h, 1)
})

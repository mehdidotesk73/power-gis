// The graph: Copy as image puts a PNG of what the graph's window shows (as panned and zoomed) on the
// clipboard.
import { expect, test } from '@playwright/test'
import { closeDevices, closeWorkspacePanel, device, setUpStateIncome, startSmall } from './helpers'

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

test('the layout menu: pick a layout and the graph turns; a tap elsewhere closes the menu', async ({ browser }) => {
  const page = await device(browser)
  await setUpStateIncome(page)
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  const node = (name: string) => page.locator(`[data-testid="node.dataset"][data-name="${name}"]`)
  const pos = async (name: string) => (await node(name).boundingBox())!
  // Top to bottom: a transform's output sits below its input.
  expect((await pos('State income')).y).toBeGreaterThan((await pos('Clean county income')).y + 20)

  await page.getByTestId('graph.layout').click()
  await expect(page.getByTestId('graph.layout.horizontal')).toBeVisible()
  await page.getByTestId('graph.layout.horizontal').click()
  await expect(page.getByTestId('graph.layout.horizontal')).toHaveCount(0) // closed again
  await expect.poll(async () => (await pos('State income')).x - (await pos('Clean county income')).x).toBeGreaterThan(20)

  // Open, then a tap elsewhere: closed, nothing changed.
  await page.getByTestId('graph.layout').click()
  await expect(page.getByTestId('graph.layout.vertical')).toBeVisible()
  await page.locator('.dag .hint').click()
  await expect(page.getByTestId('graph.layout.vertical')).toHaveCount(0)
  expect((await pos('State income')).x).toBeGreaterThan((await pos('Clean county income')).x + 20)

  // The compact layouts are there too, and the button shows the one in use.
  await page.getByTestId('graph.layout').click()
  await page.getByTestId('graph.layout.vertical-compact').click()
  await expect(page.getByTestId('graph.layout')).toContainText('⇊')
  await expect.poll(async () => (await pos('State income')).y - (await pos('Clean county income')).y).toBeGreaterThan(20)
})

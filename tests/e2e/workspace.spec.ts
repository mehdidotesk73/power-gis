// Workspace files: Download makes a zip of the workspace's files; Load on another device opens the same
// workspace from it.
import { expect, test, type Page } from '@playwright/test'
import { card, closeDevices, closeWorkspacePanel, device, listPanel, loadWorkspaceFile, openSample, openWorkspacePanel, ready, startSmall } from './helpers'

test.afterEach(closeDevices)

/** Every node in the graph, by kind and name. */
async function nodes(page: Page) {
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  return (await page.locator('[data-testid^="node."]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-testid')} ${e.getAttribute('data-name')}`))).sort()
}

test('a downloaded zip opens the same workspace on another device', async ({ browser }, info) => {
  const a = await device(browser)
  await startSmall(a)
  await closeWorkspacePanel(a)
  const before = await nodes(a)
  expect(before).toContain('node.dataset US counties')

  await openWorkspacePanel(a)
  const download = a.waitForEvent('download')
  await a.getByTestId('workspace.download').click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/\.powergis\.zip$/)
  const path = info.outputPath(file.suggestedFilename())
  await file.saveAs(path)

  const b = await device(browser) // a fresh device starts empty
  expect(await nodes(b)).not.toEqual(before)
  await loadWorkspaceFile(b, path)
  expect(await nodes(b)).toEqual(before)
})

// The user's own check on the phone (2026-10-29): after a download, Copy / Paste / Load still work.
test('download, change, download again, discard; copy, load the second zip, paste the first state back', async ({ browser, baseURL }, info) => {
  const page = await device(browser)
  await openSample(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
  const SCORE = 'County socioeconomic score (0-100)'
  const pill = async () => {
    await listPanel(page, 'Visualizations')
    return card(page, 'viz', SCORE).locator('.vis')
  }
  const download = async (name: string) => {
    await openWorkspacePanel(page)
    const d = page.waitForEvent('download')
    await page.getByTestId('workspace.download').click()
    const path = info.outputPath(name)
    await (await d).saveAs(path)
    return path
  }
  await expect(await pill()).toHaveText('Visible')
  await download('before.powergis.zip')

  await (await pill()).click() // hide the score: an unsaved change
  await expect(await pill()).toHaveText('Hidden')
  const changed = await download('changed.powergis.zip')

  await openWorkspacePanel(page)
  await page.getByRole('button', { name: 'Discard changes' }).click()
  await expect(await pill()).toHaveText('Visible')

  // Copy after a download: the workspace's JSON is on the clipboard.
  await openWorkspacePanel(page)
  await page.getByRole('button', { name: /Copy workspace/ }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(JSON.parse(copied)).toMatchObject({ format: 'powergis-workspace', version: 2 })

  // Load the second zip: the change comes back.
  await loadWorkspaceFile(page, changed)
  await expect(await pill()).toHaveText('Hidden')

  // Paste the copied workspace: the score shows again.
  await openWorkspacePanel(page)
  await page.getByRole('button', { name: /Paste workspace/ }).click()
  await expect(page.locator('.paste textarea')).toHaveValue(copied)
  await page.locator('.paste').getByRole('button', { name: 'Load' }).click()
  await ready(page)
  await expect(await pill()).toHaveText('Visible')
})

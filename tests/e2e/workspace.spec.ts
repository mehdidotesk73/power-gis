// Workspace files: Download makes a zip of the workspace's files; Load on another device opens the same
// workspace from it.
import { expect, test, type Page } from '@playwright/test'
import { closeDevices, closeWorkspacePanel, device, loadWorkspaceFile, openWorkspacePanel, startSmall } from './helpers'

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

  const b = await device(browser) // a fresh device opens the default map first
  expect(await nodes(b)).not.toEqual(before)
  await loadWorkspaceFile(b, path)
  expect(await nodes(b)).toEqual(before)
})

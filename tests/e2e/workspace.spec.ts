// Workspace files: Download makes a zip of the workspace's files; Load on another device opens the same
// workspace from it.
import { expect, test, type Page } from '@playwright/test'
import { card, cardAction, closeDevices, closeWorkspacePanel, device, listPanel, loadWorkspaceFile, openSample, openWorkspacePanel, PHONE, ready, reload, saveWorkspace, startSmall } from './helpers'

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

test('the About note is written in the Workspace panel, saved with the workspace, and kept after a reload', async ({ browser }) => {
  const page = await device(browser, PHONE)
  await startSmall(page)
  await openWorkspacePanel(page)
  const about = page.getByTestId('workspace.about')
  await expect(about).toContainText('not written yet')
  await about.locator('summary').click()
  await about.getByLabel('About this workspace').fill('## Question\nWhere is a therapy practice viable?\n\n## Sources\n- CDC PLACES: depression and distress by county.')
  await about.locator('summary').click() // blur: the note goes into the draft
  await expect(about).toContainText('Where is a therapy practice viable?')
  await page.screenshot({ path: test.info().outputPath('about-phone.png') })
  await page.getByTestId('workspace.save').click()
  await expect(page.getByText(/All changes saved/)).toBeVisible()
  await reload(page)
  await openWorkspacePanel(page)
  await expect(page.getByTestId('workspace.about')).toContainText('Where is a therapy practice viable?')
  await page.getByTestId('workspace.about').locator('summary').click()
  await expect(page.getByTestId('workspace.about').getByLabel('About this workspace')).toHaveValue(/CDC PLACES: depression and distress by county\./)
})

test('a dataset keeps a plain-language description, structured metadata and notes, through Save and a reload', async ({ browser }) => {
  const page = await device(browser, PHONE)
  await startSmall(page)
  await listPanel(page, 'Datasets')
  const counties = card(page, 'dataset', 'US counties')
  await cardAction(page, counties, 'edit')
  const editor = page.getByTestId('dataset-editor')
  await editor.getByLabel('Description').fill('The outline of every US county, from the Census Bureau, the federal statistics agency.')
  await editor.getByLabel('Description').blur()
  await editor.getByTestId('metadata.edit').click()
  await editor.getByLabel('What one row is').fill('one per US county')
  await editor.getByLabel('Key').fill('fips (5-digit text)')
  await editor.getByLabel('Publisher').fill('Census Bureau')
  await editor.getByLabel('Who they are').fill('the federal statistics agency')
  await editor.getByLabel('Period').fill('2017')
  await editor.getByLabel('Caveats').fill("Connecticut's eight old counties\nCartographic (1:10m), not survey-grade")
  await editor.getByLabel('Add a column').selectOption('name')
  await editor.getByLabel('name: meaning').fill('county and state, e.g. "Autauga, AL"')
  await editor.getByTestId('metadata.done').click()
  await expect(editor.getByTestId('dataset.metadata')).toContainText('Row: one per US county · key fips (5-digit text)')
  await expect(editor.getByTestId('dataset.metadata')).toContainText('Source: Census Bureau (the federal statistics agency): 2017')
  await editor.getByTestId('dataset.notes').fill('Made from the us-atlas package.')
  await editor.getByTestId('dataset.notes').blur()
  await page.screenshot({ path: test.info().outputPath('dataset-metadata-phone.png'), fullPage: true })
  await expect(counties).toContainText('one per US county · Census Bureau (the federal statistics agency): 2017')

  await saveWorkspace(page)
  await reload(page)
  await listPanel(page, 'Datasets')
  await cardAction(page, card(page, 'dataset', 'US counties'), 'edit')
  const again = page.getByTestId('dataset-editor')
  await expect(again.getByLabel('Description')).toHaveValue(/federal statistics agency/)
  await expect(again.getByTestId('dataset.metadata')).toContainText("Caveats: Connecticut's eight old counties · Cartographic (1:10m), not survey-grade")
  await expect(again.getByTestId('dataset.metadata')).toContainText('Columns: name (county and state, e.g. "Autauga, AL")')
  await expect(again.getByTestId('dataset.notes')).toHaveValue('Made from the us-atlas package.')
})

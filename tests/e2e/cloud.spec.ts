// Two people and several devices against the local Supabase stack, through the
// UI: each device is its own browser context (its own storage), as a phone
// and a laptop are. Data: the state-income workspace (tests/fixtures).
import { expect, test } from '@playwright/test'
import { account, card, device, LAPTOP, linkToCloud, listPanel, PHONE, ready, saveWorkspace, setUpStateIncome, signIn } from './helpers'

test('one person, two devices: what is linked arrives, what is only on the first device is named as missing', async ({ browser }) => {
  const anna = await account('anna')
  const laptop = await device(browser, LAPTOP)
  await signIn(laptop, anna)
  await setUpStateIncome(laptop)
  // One upload and one output go to the cloud; the other upload stays on the laptop.
  await linkToCloud(laptop, 'county_income')
  await linkToCloud(laptop, 'State income')
  await saveWorkspace(laptop)

  // The phone: signing in opens the account's workspace.
  const phone = await device(browser, PHONE)
  await signIn(phone, anna)
  await expect(phone.getByText(/Opened your workspace from your account/)).toBeVisible({ timeout: 120_000 })
  await expect(phone.getByRole('dialog', { name: 'Workspace' })).toContainText('"county_education" (3,222 rows)')
  await ready(phone)
  await listPanel(phone, 'Datasets')
  await expect(card(phone, 'dataset', 'county_income')).toContainText('Cloud')
  await expect(card(phone, 'dataset', 'State income')).toContainText('Cloud')
  await expect(card(phone, 'dataset', 'State income')).toContainText('56 rows')
  // Only on the laptop: named, with why.
  await expect(phone.locator('[data-testid="missing-dataset"][data-name="county_education"]')).toContainText('another device')
  // Built-ins are made here; the transform whose input arrived made its output here too.
  await expect(card(phone, 'dataset', 'US states')).toContainText('56 rows')
  await expect(card(phone, 'dataset', 'Clean county income')).toContainText('3,222 rows')
  await phone.screenshot({ path: 'test-results/cloud-1-phone.png' })
})

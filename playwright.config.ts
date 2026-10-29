// UI tests (tests/e2e): the built app in a real browser against a local Supabase
// stack, clicking and typing through the same controls a person uses. Build it
// first against the stack (`npm run build:e2e`, see tests/e2e/README.md);
// `npx playwright test` serves that build and runs the tests.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite preview --outDir dist-e2e --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
})

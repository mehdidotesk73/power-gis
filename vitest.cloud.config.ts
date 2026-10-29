// `npm run test:cloud`: the integration tests in tests/cloud, against a local
// Supabase stack (`supabase start`). Kept out of `npm test`, which needs no stack.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/cloud/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
})

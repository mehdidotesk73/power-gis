import { describe, expect, it } from 'vitest'
import { describeTool, expectedFiles, withoutFilesLine } from './managed'
import { chatCost } from './claude'

describe('describeTool', () => {
  it('shows a URL on its own, so it links cleanly', () => {
    expect(describeTool('web_fetch', { url: 'https://ir.homedepot.com/financial-reports/annual-reports/recent' })).toBe(
      'web_fetch https://ir.homedepot.com/financial-reports/annual-reports/recent',
    )
  })
  it('shows a search query, a command’s first line, a file, or the JSON', () => {
    expect(describeTool('web_search', { query: 'census acs b19013' })).toBe('web_search “census acs b19013”')
    expect(describeTool('bash', { command: 'cd /tmp\npython3 x.py\nls' })).toBe('bash: cd /tmp (+2 lines)')
    expect(describeTool('write', { file_path: '/mnt/session/outputs/script.py', content: 'x' })).toBe('write /mnt/session/outputs/script.py')
    expect(describeTool('other', { a: 1 })).toBe('other {"a":1}')
  })
})

describe('the files a run reports', () => {
  it('reads the last FILES line, file names only', () => {
    const report = 'Wrote both.\n\n**FILES:** `rents.csv`, /mnt/session/outputs/states.geojson, script.py'
    expect(expectedFiles(report)).toEqual(['rents.csv', 'states.geojson', 'script.py'])
    expect(withoutFilesLine(report)).toBe('Wrote both.')
    expect(expectedFiles('No files line')).toEqual([])
    expect(expectedFiles('FILES: none')).toEqual([])
  })
})

describe('the chat cost', () => {
  it('prices tokens at list prices, cache writes and reads included', () => {
    const u = { input: 100_000, output: 10_000, cacheRead: 1_000_000, cacheWrite: 100_000 }
    // Haiku 5.5: $0.10 in / $0.50 out per million.
    expect(chatCost(u, 'claude-haiku-5-5')).toBeCloseTo(0.01 + 0.0125 + 0.01 + 0.005, 6)
    expect(chatCost(u, 'claude-haiku-4-5')).toBeUndefined()
  })
})

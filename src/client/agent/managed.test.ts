import { describe, expect, it } from 'vitest'
import { describeTool } from './managed'

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

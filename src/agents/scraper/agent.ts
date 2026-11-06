import { fill, type ManagedAgent } from '../agent'
import { WEB_TOOLSET } from '../web-toolset'
import webFallback from '../web-fallback.md?raw'
import prompt from './prompt.md?raw'

export const SCRAPER: ManagedAgent = {
  name: 'scraper',
  role: 'Fetches what a precise brief names and writes it as CSV / GeoJSON files.',
  runs: 'managed',
  model: 'scraper',
  prompt: fill(prompt, { WEB_FALLBACK: fill(webFallback) }),
  tools: WEB_TOOLSET,
}

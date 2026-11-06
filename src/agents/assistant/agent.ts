import { fill, type BrowserAgent } from '../agent'
import { TOOLS } from '../tools'
import { COLORMAPS } from '../../lib/colormaps'
import { ROWS } from '../../lib/dataset/visualization'
import { SQL_EXTENSIONS } from '../../shared/sqlExtensions'
import prompt from './prompt.md?raw'

export const ASSISTANT: BrowserAgent = {
  name: 'assistant',
  role: 'The dataset processor: frames requests with the user, finds and shapes data, builds transforms and maps.',
  runs: 'browser',
  model: 'assistant',
  prompt: fill(prompt, {
    ROWS,
    COLORMAPS: Object.keys(COLORMAPS).join(', '),
    SQL_EXTENSIONS: SQL_EXTENSIONS.map((x) => `${x.name} — ${x.purpose}`).join('; '),
  }),
  tools: TOOLS,
}

import { fill, type BrowserAgent } from '../agent'
import { STORYTELLER_TOOLS } from '../tools/storyteller'
import { MAX_FIGURES, MAX_SCENES, NARRATIVE_WORDS } from '../../lib/story/story'
import prompt from './prompt.md?raw'

export const STORYTELLER: BrowserAgent = {
  name: 'storyteller',
  role: 'Writes a story about some visualizations from what the workspace keeps; changes nothing else.',
  runs: 'browser',
  model: 'storyteller',
  prompt: fill(prompt, { MAX_SCENES, NARRATIVE_WORDS, MAX_FIGURES }),
  tools: STORYTELLER_TOOLS,
}

import { fill, type BrowserAgent } from '../agent'
import prompt from './prompt.md?raw'

export const DIAGNOSIS: BrowserAgent = {
  name: 'diagnosis',
  role: "Reads a chat's steps, runs and log after something expensive or unexpected failed, and writes an issue report.",
  runs: 'browser',
  model: 'chosen',
  prompt: fill(prompt),
  tools: [],
}

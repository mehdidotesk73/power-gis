import { fill, type ManagedAgent } from '../agent'
import { WEB_TOOLSET } from '../web-toolset'
import webFallback from '../web-fallback.md?raw'
import prompt from './prompt.md?raw'

export const SCOUT: ManagedAgent = {
  name: 'scout',
  role: "Finds out what data exists for a brief's needs, where and in what form, and reports the sources.",
  runs: 'managed',
  model: 'scout',
  prompt: fill(prompt, { WEB_FALLBACK: fill(webFallback) }),
  tools: WEB_TOOLSET,
}

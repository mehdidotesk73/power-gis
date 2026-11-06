// Every agent in the app (each folder: agent.ts = its config, prompt.md = its prompt; tools/ = their tools).
export { ASSISTANT } from './assistant/agent'
export { STORYTELLER } from './storyteller/agent'
export { SCOUT } from './scout/agent'
export { SCRAPER } from './scraper/agent'
export { DIAGNOSIS } from './diagnosis/agent'
export type { AgentConfig, BrowserAgent, ManagedAgent, ModelSlot } from './agent'

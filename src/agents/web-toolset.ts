// What the scout and the scraper (Managed Agents) can use: Anthropic's full built-in toolset (web search and fetch,
// bash, files, a browser), every action allowed — they run in their own sandbox on Anthropic's side.
export const WEB_TOOLSET = [{ type: 'agent_toolset_20260401', default_config: { enabled: true, permission_policy: { type: 'auto' } } }]

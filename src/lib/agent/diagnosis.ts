// The diagnosis agent: called when something expensive or unexpected went wrong
// in a chat (a scout or scraper run that failed or whose results went missing,
// failures that repeat). The user approves it and picks its model (it can be
// costly); it reads what happened — the chat's steps with their inputs and
// results, the runs (ids, logs, errors), the app's log — and writes an issue
// report the user can send to the app's developers. One model call, no tools.

/** Models to choose from on the approval card, the strongest first (recommended). */
export const DIAGNOSIS_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5 · most thorough' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 · balanced' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 · quickest, cheapest' },
]

// Its prompt: src/agents/diagnosis (agent.ts + prompt.md).

export interface DiagnosisStep {
  kind: string
  text: string
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}… [${t.length - n} more characters]` : t)

/** What the diagnosis agent reads, as one message. Long inputs and results are cut; errors and ids are kept whole. */
export function diagnosisInput(o: {
  whatHappened: string
  steps: DiagnosisStep[]
  runs: unknown[]
  /** The runs read back from Anthropic (what each did after the app lost touch, if it did). */
  traces?: string[]
  log: string
  build: string
  userAgent: string
  now: string
}): string {
  const steps = o.steps.map((s, i) => `### ${i + 1}. ${s.kind}\n${clip(s.text, 3000)}`).join('\n\n')
  return [
    `# What the assistant says happened\n${o.whatHappened}`,
    `# The app\nBuild ${o.build} · ${o.userAgent} · now ${o.now}`,
    `# This device's recent scout / scraper runs\n${clip(JSON.stringify(o.runs, null, 1), 6000)}`,
    ...(o.traces?.length ? [`# The runs as Anthropic kept them (read back by id: everything each did, even after the app lost touch)\n${o.traces.map((t) => clip(t, 15_000)).join('\n\n')}`] : []),
    `# The chat's steps, in order\n${clip(steps, 60_000)}`,
    `# The app's debug log (newest last)\n${clip(o.log, 12_000)}`,
  ].join('\n\n')
}

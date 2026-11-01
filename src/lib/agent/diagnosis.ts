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

export const DIAGNOSIS_PROMPT = `You diagnose problems in PowerGIS, a map app whose in-app assistant (an AI) works on the user's data and sends a scout and a scraper (agents on Anthropic's Managed Agents, reached through the app's relay, a Supabase Edge Function) to fetch data from the web. Something expensive or unexpected went wrong. You get: what the assistant says happened; the chat's steps in order (the user's messages, the assistant's tool calls with their inputs and results, scout / scraper runs with their run ids, progress logs, results and errors, notes); this device's recent runs; the runs read back from Anthropic by id (everything each did, even after the app lost touch: compare it with what the chat saw); and the app's debug log.

Write an issue report for the app's developers, who will read it with the code at hand. Be specific and evidence-based: quote the exact error texts, run ids, tool names and the order of events. Separate what the evidence shows from what you infer, and say how confident you are. Plain markdown, these sections:

## Summary
Two or three sentences: what went wrong and what it cost (money, time, lost results).

## Timeline
The relevant steps in order, each with its tool / run id and what came back.

## Likely cause
Your best explanation, with the evidence for it; then other possible causes, ranked, and what would tell them apart.

## Impact
What the user lost or had to do by hand; whether money may have been spent twice; whether results can still be recovered (a run's results stay on Anthropic's side and can be fetched by its run id).

## Suggested fixes
For the developers: concrete changes to the app, the relay, the tools or the prompts. For the user now: what to do next (e.g. fetch a run's results by id).

## Details for troubleshooting
Run ids, build, error texts verbatim, anything else worth checking.`

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

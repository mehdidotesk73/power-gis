// A diagnosis of what went wrong, asked for when something expensive or unexpected failed.
// Each tool: its spec (what the model sees) next to its handler (what runs).

import type { ToolOutcome } from '../../lib/agent/loop'
import type { ToolSpec } from '../../lib/agent/provider'
import { Obj, err, need, ok, str } from './common'
import { AgentHost } from './host'

export const DIAGNOSE_TOOLS: ToolSpec[] = [
  {
    name: 'diagnose',
    description:
      'Ask for a diagnosis when something expensive or unexpected went wrong in this chat — a scout or scraper run that failed or whose results went missing, repeated failures you can\'t explain, results that contradict each other — not for an ordinary mistake you can fix yourself (a SQL error, a wrong column). The user approves it and picks the model (it can be costly); a separate agent then reads this chat\'s steps, their inputs and results, the runs, errors and the app\'s log, and writes an issue report the user can send to the app\'s developers. It returns the report; tell the user it is in the chat, and carry on with what it suggests you can do.',
    inputSchema: {
      type: 'object',
      properties: { what_happened: { type: 'string', description: 'What went wrong, as you saw it: what you did, what came back, what you expected, and what it cost the user.' } },
      required: ['what_happened'],
    },
  },
]

export async function diagnose(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.what_happened) && input.what_happened.trim(), '`what_happened` is required')
  if (!host.diagnose) return err('The diagnosis isn\'t available here.')
  const r = await host.diagnose(input.what_happened.trim())
  if (typeof r === 'string') return err(r, 'no diagnosis')
  return ok({ report: r.report, note: 'The report is in the chat (the user can copy it for the developers).' }, `report written · ${r.model}`)
}

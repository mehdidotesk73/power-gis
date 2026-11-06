// Hand a story to the storyteller.
// Each tool: its spec (what the model sees) next to its handler (what runs).

import type { ToolOutcome } from '../../lib/agent/loop'
import type { ToolSpec } from '../../lib/agent/provider'
import { Obj, err, need, ok, plural, str } from './common'
import { AgentHost } from './host'

export const STORY_TOOLS: ToolSpec[] = [
  {
    name: 'tell_story',
    description:
      'Have the storyteller write a story (it only writes the story: it changes nothing else in the workspace) about some visualizations, for someone who isn\'t a data person: the base data in plain words (who published it, what it measures), what the steps compute and why, then the maps and their headlines; short scenes with a figure or two (rows, a chart, a map). It reads only what the workspace keeps — the About note (/about.md), the datasets\' descriptions and the SQL, never this chat. Before calling it, fill in only what is missing (no About, a dataset without a description or source); never rewrite descriptions or metadata that are already there for the story\'s sake. Give the visualizations\' ids, the user\'s wishes for it ("" if none), and storyId to rewrite an existing story ("" for a new one): a rewrite keeps the story\'s own visualizations (the overview lists them under Stories) unless the user asks for others. It returns the story\'s id, title and scenes; the story is in the workspace draft (Stories in the list view). It changes nothing else.',
    inputSchema: {
      type: 'object',
      properties: {
        visualizationIds: { type: 'array', items: { type: 'string' } },
        wishes: { type: 'string', description: 'What the user asked of the story (focus, length, audience, changes to make), or "".' },
        storyId: { type: 'string', description: 'The story to rewrite, or "" for a new one.' },
      },
      required: ['visualizationIds', 'wishes', 'storyId'],
    },
  },
]

/** Runs a tool call: validated, gated, never throwing. */
export async function tellStory(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(host.tellStory, 'The storyteller isn\'t available here')
  need(Array.isArray(input.visualizationIds) && input.visualizationIds.length && input.visualizationIds.every(str), '`visualizationIds` must list at least one visualization id')
  const doc = host.doc()
  const unknown = (input.visualizationIds as string[]).filter((id) => !doc.visualizations.some((v) => v.id === id))
  need(!unknown.length, `No visualization ${unknown.map((u) => `"${u}"`).join(', ')} in the workspace (get_workspace lists them)`)
  const storyId = str(input.storyId) && input.storyId ? input.storyId : undefined
  need(!storyId || (doc.stories ?? []).some((x) => x.id === storyId), `No story "${storyId}" to rewrite`)
  const r = await host.tellStory({ visualizationIds: input.visualizationIds as string[], wishes: str(input.wishes) ? input.wishes.trim() : '', ...(storyId ? { storyId } : {}) })
  if (typeof r === 'string') return err(r, 'not written')
  return ok({ ...r, note: 'The story is in the workspace draft (Stories, in the list view); the user saves it with the workspace.' }, `“${r.name}” · ${plural(r.scenes.length, 'scene')}`)
}

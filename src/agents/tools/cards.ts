// Asking the user: one-off question cards and the fixed exchanges (Plan, Source pick, Frame).
// Each tool: its spec (what the model sees) next to its handler (what runs).

import { setAbout, type WorkspaceDoc } from '../../lib/workspace/workspace'
import type { ToolOutcome } from '../../lib/agent/loop'
import type { ToolSpec } from '../../lib/agent/provider'
import { answerForAgent, answerSummary, commentsOf, LIMITS, readCard, type Card } from '../../lib/agent/form'
import { USER_NOTES, frameCard, frameOutcome, frameSection, planCard, planOutcome, POSTURES, sourceCard, sourceOutcome, withFrame, type FrameComponent, type Posture, type Rounds, type SourceOption } from '../../lib/agent/exchanges'
import { Obj, need, ok, str } from './common'
import { AgentHost } from './host'

export const CARDS_TOOLS: ToolSpec[] = [
  {
    name: 'ask_user',
    strict: true,
    description: [
      'Ask the user a one-off question and wait for the answer. A card: "title" (what you ask, one sentence), "context" (what you found, a few lines), then up to 3 related "questions", answered together by one pair of "buttons" — so the user can answer interconnected questions in one go.',
      'Each question: "question" (one sentence), "why" (why you ask and what the answer changes), and a kind. "answer": your own considered response (or a draft) in "text", which the user edits — never ask for an empty box. "one": radio buttons — your "options" (2+), "recommended" = one of them (shown first, marked); "neither": true adds "Neither (see comments)" when an answer outside your options is plausible (false only when they cover every case). "several": checkboxes — "options", "selected" = those ticked to start (to edit a selection). Every question gets a comments box from the app.',
      '"buttons": a pair, what goes ahead first: Submit / Cancel (default with questions), Yes / No (default with none: a plain yes / no question), Approve / Reject, Go / No-go. Returns {button, answers: [one per question: an unchanged answer comes back as just edited: false; a choice as choice / choices; neither: true when the user picked none; comments]}.',
      'For a plan use propose_plan, for a source after the scout pick_source, and the scout / scraper card comes with send_scout / send_scraper: those are fixed exchanges. For a truly open question, ask in plain text and end your turn instead.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the card asks, one sentence.' },
        context: { type: 'string', description: 'What you found or propose, a few short lines; "" for none.' },
        questions: {
          type: 'array',
          description: `0–${LIMITS.questions} questions that belong together; [] for a plain yes / no.`,
          // Every property required (empty when unused): under strict tool use, optional ones inside items came through missing.
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['answer', 'one', 'several'] },
              question: { type: 'string', description: 'One sentence.' },
              why: { type: 'string', description: 'Why you ask and what the answer changes.' },
              text: { type: 'string', description: 'answer: your response or draft, in full (the box shows only this); "" for a choice.' },
              options: { type: 'array', items: { type: 'string' }, description: `one / several: the options, at most ${LIMITS.options}; [] for an answer.` },
              recommended: { type: 'string', description: 'one: the option you recommend; "" for none.' },
              neither: { type: 'boolean', description: 'one: offer "Neither (see comments)".' },
              selected: { type: 'array', items: { type: 'string' }, description: 'several: the options ticked to start; [] otherwise.' },
              required: { type: 'boolean', description: 'The first button waits for it.' },
            },
            required: ['kind', 'question', 'why', 'text', 'options', 'recommended', 'neither', 'selected', 'required'],
          },
        },
        buttons: { type: 'array', items: { type: 'string' }, description: 'The pair: goes ahead first, then doesn\'t. [] for the default (Submit / Cancel, or Yes / No without questions).' },
      },
      required: ['title', 'questions'],
    },
  },
  {
    name: 'propose_plan',
    description:
      'The Plan exchange: show the user your build plan, stage by stage (what you\'ll make, from what, and why), to edit and approve before you build. Approve / Reject, plus Revise with my notes (at most 2 rounds: redraft from their comments and edits and call this again). Returns {decision: approved | revise | declined, plan (only if the user edited it), comments, next}.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The plan in full, stage by stage, in plain words.' },
        why: { type: 'string', description: 'A line on what to check in it; "" for none.' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'pick_source',
    strict: true,
    description:
      'The Source pick exchange: after the scout, let the user choose the source(s) for one need among those it found — each with its coverage, terms and fit, and what exactly it measures (units, money basis, mean or median, period), in a line. Several may answer a need together (one anchors, another fills in): recommend every source you would use, and when that is more than one, give "combination": how they combine (what anchors, what fills in, how they are calibrated where they overlap, and any extra data that needs) — the user edits it. When candidates measure different things, say so in their lines. Use these / Not now, plus Revise with my notes (at most 2 rounds: redraft from their comments and edits and call this again). Returns {decision: approved | revise | declined, sources (the names kept), combination (as edited), comments, next}.',
    inputSchema: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'The need, in a few words ("average annual wage per country").' },
        why: { type: 'string', description: 'A line on what the choice changes; "" for none.' },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, detail: { type: 'string', description: 'Coverage, terms and fit, and what exactly it measures, in one line.' } },
            required: ['name', 'detail'],
          },
        },
        recommended: { type: 'array', items: { type: 'string' }, description: 'The names of the sources you would use (one or several); [] for none.' },
        combination: { type: 'string', description: 'When you recommend several: how they combine; "" otherwise.' },
      },
      required: ['need', 'sources', 'recommended', 'combination'],
    },
  },
  {
    name: 'propose_frame',
    strict: true,
    description: [
      'The Frame exchange: the end of framing, not its start. Call it only after rounds with the user (ask_user): your reading, the components (asking which they would add), each component\'s factors (asking what they think drives it, then extending their reasoning to ones they didn\'t name), until nothing needs clarifying. Then show how you read the request and what you will measure, to edit and approve. Approve / Reject, plus Revise with my notes (at most 2 rounds). On Approve the frame is written into the workspace\'s About note (its "Study frame" section) for every later step and the storyteller.',
      '"framing": a short paragraph — the question as the user asked it (not an easier neighbour: when a proxy stands in, say so), exactly what is measured (what, in which units and money basis, mean or median, which period), the window (where, when) and the unit of analysis as the request and the data allow, and which way is better. "components": the measures or facets that make it up, each with its posture — "exact" (data at the unit wanted), "anchor + proxy" (reliable data that relates to it, carried over through a relationship: other places, a coarser unit, a neighbouring measure), "fermi" (a first-principles range, low / likely / high) — a few words of note, and key: true for the core ones (optional ones start unticked). "decision": the one open choice about the measure that would change the answer (two readings, market vs purchasing-power money, mean vs median…), or {"question": ""} when there is none.',
      'Returns {decision: approved | revise | declined, framing (only if edited), the decision\'s answer, the components kept and left out, comments, next}.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        framing: { type: 'string' },
        why: { type: 'string', description: 'A line on what to check in it; "" for none.' },
        components: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              posture: { type: 'string', enum: [...POSTURES] },
              note: { type: 'string', description: 'A few words: what measures it, or why that posture; "" for none.' },
              key: { type: 'boolean' },
            },
            required: ['name', 'posture', 'note', 'key'],
          },
        },
        decision: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '"" when there is no open choice.' },
            why: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            recommended: { type: 'string', description: 'The option that answers the question as asked; "" for none.' },
          },
          required: ['question', 'why', 'options', 'recommended'],
        },
      },
      required: ['framing', 'why', 'components', 'decision'],
    },
  },
]

export async function askUser(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  const card = readCard(input)
  need(typeof card !== 'string', card as string)
  const c = card as Card
  const a = await host.ask(c)
  const note = commentsOf(a).length ? { note: USER_NOTES } : {}
  return ok({ ...answerForAgent(c, a), ...note }, answerSummary(c, a))
}

export const roundsOf = (host: AgentHost): Rounds => (host.rounds ??= new Map())

export async function proposePlan(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.plan) && input.plan.trim(), '`plan` is required: the plan in full, stage by stage')
  const card = planCard({ plan: input.plan.trim(), ...(str(input.why) && input.why.trim() ? { why: input.why.trim() } : {}) }, roundsOf(host))
  const a = await host.ask(card)
  const out = planOutcome(card, a, roundsOf(host))
  return ok({ decision: out.decision, ...out.value, ...(out.comments.length ? { comments: out.comments } : {}), next: out.next }, answerSummary(card, a))
}

export async function pickSource(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.need) && input.need.trim(), '`need` is required')
  const sources = (Array.isArray(input.sources) ? input.sources : []).filter((x): x is SourceOption => !!x && typeof x === 'object' && str((x as Obj).name) && str((x as Obj).detail))
  need(sources.length >= 1, '`sources` needs at least one source (name, detail)')
  const recommended = (Array.isArray(input.recommended) ? input.recommended : str(input.recommended) ? [input.recommended] : []).filter(str)
  const card = sourceCard({
    need: input.need.trim(),
    sources,
    recommended,
    ...(str(input.why) && input.why.trim() ? { why: input.why.trim() } : {}),
    ...(str(input.combination) && input.combination.trim() ? { combination: input.combination.trim() } : {}),
  }, roundsOf(host))
  const a = await host.ask(card)
  const out = sourceOutcome(card, a, sources, roundsOf(host))
  return ok({ decision: out.decision, ...out.value, ...(out.comments.length ? { comments: out.comments } : {}), next: out.next }, answerSummary(card, a))
}

export async function proposeFrame(host: AgentHost, input: Obj): Promise<ToolOutcome> {
  need(str(input.framing) && input.framing.trim(), '`framing` is required: how you read the request and exactly what is measured')
  const components = (Array.isArray(input.components) ? input.components : []).flatMap((x): FrameComponent[] => {
    if (!x || typeof x !== 'object' || !str((x as Obj).name) || !(x as Obj).name) return []
    const c = x as Obj
    const posture = (POSTURES as readonly string[]).includes(c.posture as string) ? (c.posture as Posture) : 'exact'
    return [{ name: (c.name as string).trim(), posture, ...(str(c.note) && c.note.trim() ? { note: c.note.trim() } : {}), key: c.key !== false }]
  })
  need(components.length >= 1, '`components` needs at least one component (name, posture, note, key)')
  const d = input.decision as Obj | undefined
  const options = d && Array.isArray(d.options) ? d.options.filter(str).map((o) => o.trim()).filter(Boolean) : []
  const decision = d && str(d.question) && d.question.trim() && options.length >= 2 ? { question: d.question.trim(), options, ...(str(d.why) && d.why.trim() ? { why: d.why.trim() } : {}), ...(str(d.recommended) && options.includes(d.recommended.trim()) ? { recommended: d.recommended.trim() } : {}) } : undefined
  const frame = { framing: input.framing.trim(), components, ...(decision ? { decision } : {}), ...(str(input.why) && input.why.trim() ? { why: input.why.trim() } : {}) }
  const card = frameCard(frame, roundsOf(host))
  const a = await host.ask(card)
  const out = frameOutcome(card, a, roundsOf(host), frame)
  if (out.decision === 'approved' && out.value) {
    // The study frame goes into About, where every later step and the storyteller read it.
    const doc = host.doc()
    const about = withFrame(doc.about, frameSection(out.value))
    host.setDoc((setAbout(doc, about) as { ok: true; doc: WorkspaceDoc }).doc)
  }
  const v = out.value
  const result = v
    ? {
        ...(v.edited ? { framing: v.framing } : { edited: false }),
        ...(v.decision ? { measure: v.decision } : {}),
        kept: v.components.filter((c) => c.kept).map((c) => `${c.name} (${c.posture})`),
        leftOut: v.components.filter((c) => !c.kept).map((c) => c.name),
        savedTo: 'About (/about.md), section "Study frame"',
      }
    : {}
  return ok({ decision: out.decision, ...result, ...(out.comments.length ? { comments: out.comments } : {}), next: out.next }, answerSummary(card, a))
}

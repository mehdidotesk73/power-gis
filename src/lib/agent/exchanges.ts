// Exchanges (docs/agents.md, *Question cards and exchanges*): structured asks
// defined here, not by the agent — their purpose, their questions, their result
// and what the app does with it. The agent supplies only the content. They share
// one loop: Approve (the result, returned and used), Revise with my notes (the
// agent redrafts and asks again — at most REVISION_ROUNDS times, then it stops
// redrafting and asks what's wrong), Reject / Not now (nothing changes, the
// agent gets the reason). A new methodological question is a new exchange here,
// never a new kind of card (user, 2026-11-05).

import { commentsOf, NEITHER, REVISE, type Card, type CardAnswer, type Reply } from './form'

export const REVISION_ROUNDS = 2

/** Revisions asked in a row, per exchange (reset by any other answer). The host keeps one per chat. */
export type Rounds = Map<string, number>

export interface Outcome<T> {
  decision: 'approved' | 'revise' | 'declined' | 'stopped'
  /** For approved: what the user settled. */
  value?: T
  /** Every comment the user wrote. */
  comments: string[]
  /** What the agent should do next, in a sentence. */
  next: string
}

/** The Revise button, while rounds are left. */
const withRevise = (card: Card, rounds: Rounds, name: string): Card => ((rounds.get(name) ?? 0) < REVISION_ROUNDS ? { ...card, revise: true } : card)

function settle<T>(name: string, rounds: Rounds, card: Card, a: CardAnswer, approved: () => T): Outcome<T> {
  const comments = commentsOf(a)
  if (a.button === REVISE) {
    const n = (rounds.get(name) ?? 0) + 1
    rounds.set(name, n)
    return {
      decision: 'revise',
      comments,
      next:
        n >= REVISION_ROUNDS
          ? `Redraft from the comments and edits and ask again — this is the last revision round (${n} of ${REVISION_ROUNDS}): if it still isn't right after this, stop redrafting and ask the user what's wrong (ask_user).`
          : `Redraft from the comments and the user's edits, then ask again with the same tool (round ${n} of ${REVISION_ROUNDS}).`,
    }
  }
  rounds.delete(name)
  if (a.button === card.buttons[0]) return { decision: 'approved', value: approved(), comments, next: comments.length ? 'Go ahead, taking the comments into account.' : 'Go ahead.' }
  if (a.button === 'Stopped') return { decision: 'stopped', comments, next: 'The user stopped the assistant.' }
  return { decision: 'declined', comments, next: comments.length ? 'Nothing changes: read the comments for why, and ask before trying another way.' : 'Nothing changes: ask the user what they would rather do.' }
}

const answerText = (q: { text: string }, r: Reply | undefined) => (r?.kind === 'answer' && r.edited && r.text ? r.text : q.text)

// ── Plan: the build plan, stage by stage ───────────────────────────────────

export function planCard(input: { plan: string; why?: string }, rounds: Rounds): Card {
  return withRevise(
    {
      title: 'Approve the plan?',
      questions: [{ id: 'plan', kind: 'answer', question: 'The plan, stage by stage', why: input.why || 'What I will build before building it: change anything that should be different.', text: input.plan, required: true }],
      buttons: ['Approve', 'Reject'],
    },
    rounds,
    'plan',
  )
}
export function planOutcome(card: Card, a: CardAnswer, rounds: Rounds): Outcome<{ plan?: string; edited: boolean }> {
  const q = card.questions[0] as { text: string }
  const r = a.replies.plan
  return settle('plan', rounds, card, a, () => (r?.kind === 'answer' && r.edited ? { edited: true, plan: answerText(q, r) } : { edited: false }))
}

// ── Source pick: one need, the sources the scout found (one or several, and how they combine) ──

export interface SourceOption {
  name: string
  /** Coverage, terms and fit, in a line — and what exactly it measures (units, money basis, mean or median, period). */
  detail: string
}
const sourceLabel = (s: SourceOption) => `${s.name} — ${s.detail}`

/**
 * Several sources may answer a need together (one anchors, another fills in), so it's a Pick several with the
 * recommendation ticked, plus the agent's combination method to edit whenever it proposes one (user, 2026-11-05).
 */
export function sourceCard(input: { need: string; why?: string; sources: SourceOption[]; recommended?: string[]; combination?: string }): Card {
  const recommended = new Set(input.recommended ?? [])
  const options = input.sources.map(sourceLabel)
  return {
    title: `Which source${input.sources.length > 1 ? 's' : ''} for ${input.need}?`,
    questions: [
      {
        id: 'sources',
        kind: 'several',
        question: `The source${input.sources.length > 1 ? 's' : ''} for ${input.need}`,
        why: input.why || 'What the scout found for this need; what you keep is what the scraper fetches. Tick none and say in the comments what instead.',
        options,
        selected: input.sources.filter((s) => recommended.has(s.name)).map(sourceLabel),
      },
      ...(input.combination?.trim()
        ? [{ id: 'combination', kind: 'answer' as const, question: 'How they combine', why: 'What anchors, what fills in, and how they are calibrated where they overlap: change anything that should be different.', text: input.combination.trim() }]
        : []),
    ],
    buttons: ['Use these', 'Not now'],
  }
}
export function sourceOutcome(card: Card, a: CardAnswer, sources: SourceOption[]): Outcome<{ sources: string[]; combination?: string; combinationEdited?: boolean }> {
  const r = a.replies.sources
  const c = a.replies.combination
  const comb = card.questions.find((q) => q.id === 'combination') as { text: string } | undefined
  const out = settle('source', new Map(), card, a, () => ({
    sources: r?.kind === 'several' ? r.choices.map((label) => sources.find((s) => sourceLabel(s) === label)?.name ?? label) : [],
    ...(comb ? { combination: answerText(comb, c), combinationEdited: c?.kind === 'answer' && c.edited } : {}),
  }))
  if (out.decision === 'approved' && out.value) {
    if (!out.value.sources.length) out.next = 'None of these: read the comments for what the user wants instead (another source, a proxy, an estimate, skipping it).'
    else if (out.value.sources.length > 1 && !comb) out.next = 'The user kept several sources: say how they combine (what anchors, what fills in, how they are calibrated) before the scraper brief, and ask if it is not obvious.'
  }
  return out
}

// ── Frame: what the answer means, before any data is looked for ────────────

export const POSTURES = ['exact', 'anchor + proxy', 'fermi'] as const
export type Posture = (typeof POSTURES)[number]
export interface FrameComponent {
  name: string
  /** How its data is expected to come: at the target unit, a coarser anchor with finer proxies, or a first-principles range. */
  posture: Posture
  /** A few words: what measures it, or why that posture. */
  note?: string
  /** A key component (ticked to start) rather than an optional one. */
  key: boolean
}
export interface FrameInput {
  /** The framing: the question as asked, the measure exactly (what, units, money basis, mean or median, period), the window, the unit of analysis, which way is better. */
  framing: string
  why?: string
  components: FrameComponent[]
  /** The one open choice about the measure that changes the answer (e.g. market dollars or buying power). */
  decision?: { question: string; why?: string; options: string[]; recommended?: string }
}
const componentLabel = (c: FrameComponent) => `${c.name} — ${c.posture}${c.note ? `: ${c.note}` : ''}`

export function frameCard(input: FrameInput, rounds: Rounds): Card {
  return withRevise(
    {
      title: 'Is this the question to answer?',
      questions: [
        { id: 'framing', kind: 'answer', question: 'How I read it', why: input.why || 'What the answer will mean and exactly what is measured: everything after this follows from it.', text: input.framing, required: true },
        {
          id: 'components',
          kind: 'several',
          question: 'The components to consider',
          why: 'Each with how its data is expected to come: exact (at the unit you want), anchor + proxy (reliable coarser data, refined by finer signals), or fermi (an estimated range). Untick what to leave out; name others in the comments.',
          options: input.components.map(componentLabel),
          selected: input.components.filter((c) => c.key).map(componentLabel),
        },
        ...(input.decision
          ? [
              {
                id: 'decision',
                kind: 'one' as const,
                question: input.decision.question,
                ...(input.decision.why ? { why: input.decision.why } : {}),
                options: input.decision.recommended ? [input.decision.recommended, ...input.decision.options.filter((o) => o !== input.decision!.recommended)] : input.decision.options,
                ...(input.decision.recommended ? { recommended: input.decision.recommended, selected: input.decision.recommended } : {}),
                neither: true,
                required: true,
              },
            ]
          : []),
      ],
      buttons: ['Approve', 'Reject'],
    },
    rounds,
    'frame',
  )
}

export interface Frame {
  framing: string
  edited: boolean
  decision?: { question: string; choice: string | null; comments?: string }
  components: { name: string; posture: Posture; note?: string; kept: boolean }[]
  comments: string[]
}
export function frameOutcome(card: Card, a: CardAnswer, rounds: Rounds, input: FrameInput): Outcome<Frame> {
  return settle('frame', rounds, card, a, () => {
    const f = card.questions[0] as { text: string }
    const r = a.replies.framing
    const picked = a.replies.components
    const kept = new Set(picked?.kind === 'several' ? picked.choices : [])
    const d = a.replies.decision
    return {
      framing: answerText(f, r),
      edited: r?.kind === 'answer' && r.edited,
      ...(input.decision && d?.kind === 'one' ? { decision: { question: input.decision.question, choice: d.neither ? null : d.choice, ...(d.comments ? { comments: d.comments } : {}) } } : {}),
      components: input.components.map((c) => ({ name: c.name, posture: c.posture, ...(c.note ? { note: c.note } : {}), kept: kept.has(componentLabel(c)) })),
      comments: commentsOf(a),
    }
  })
}

/** The approved frame as the About note's "Study frame" section (markdown). */
export function frameSection(f: Frame): string {
  const kept = f.components.filter((c) => c.kept)
  const out = f.components.filter((c) => !c.kept)
  const lines = ['## Study frame', '', f.framing.trim()]
  if (f.decision) lines.push('', `**${f.decision.question}** ${f.decision.choice ?? `Neither: ${f.decision.comments ?? '(see the user\'s comments)'}`}`)
  if (kept.length) lines.push('', '**Components**', ...kept.map((c) => `- ${c.name} (${c.posture}${c.note ? `: ${c.note}` : ''})`))
  if (out.length) lines.push('', `**Left out:** ${out.map((c) => c.name).join(', ')}`)
  if (f.comments.length) lines.push('', `**The user's comments:** ${f.comments.join(' · ')}`)
  return lines.join('\n')
}

/** About with its Study frame section replaced (or added at the top): the rest of the note is kept as it is. */
export function withFrame(about: string | undefined, section: string): string {
  const text = (about ?? '').trim()
  const start = text.search(/^## Study frame\s*$/m)
  if (start < 0) return text ? `${section}\n\n${text}` : section
  const rest = text.slice(start).slice('## Study frame'.length)
  const next = rest.search(/^## /m)
  const after = next < 0 ? '' : rest.slice(next)
  return [text.slice(0, start).trim(), section, after.trim()].filter(Boolean).join('\n\n')
}

// ── Run: the scout's or scraper's brief and spending cap ───────────────────

export function runCard(input: { role: 'scout' | 'scraper'; brief: string; caps: string[]; recommended: string; capWhy?: string }): Card {
  return {
    title: `Send the ${input.role}?`,
    context:
      input.role === 'scout'
        ? 'It looks on the web and reports what data exists and how to get it; it fetches nothing.'
        : 'It fetches the data and makes the CSVs the brief names; they become new datasets in your workspace.',
    questions: [
      { id: 'brief', kind: 'answer', question: 'The brief', why: 'What it is told to do: it can\'t ask back, so change anything that should be different.', text: input.brief, required: true },
      {
        id: 'cap',
        kind: 'one',
        question: 'The spending cap',
        why: input.capWhy ? `The run stops when it reaches this. ${input.capWhy}` : 'The run stops when it reaches this.',
        options: [input.recommended, ...input.caps.filter((c) => c !== input.recommended)],
        recommended: input.recommended,
        selected: input.recommended,
        neither: true,
        required: true,
      },
    ],
    buttons: [`Send the ${input.role}`, 'Not now'],
  }
}
/** The brief as sent, and the cap: a picked option, or the amount written in the cap's comments (Neither). */
export function runOutcome(card: Card, a: CardAnswer, readCap: (v: string) => number | undefined): Outcome<{ brief: string; cap?: number }> {
  const brief = card.questions[0] as { text: string }
  return settle('run', new Map(), card, a, () => {
    const r = a.replies.cap
    const capText = r?.kind === 'one' ? (r.neither ? (r.comments ?? '') : (r.choice ?? '')) : ''
    const cap = capText ? readCap(capText) : undefined
    return { brief: answerText(brief, a.replies.brief), ...(cap !== undefined ? { cap } : {}) }
  })
}

export { NEITHER }

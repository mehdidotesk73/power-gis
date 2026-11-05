// Exchanges (docs/agents.md, *Question cards and exchanges*): structured asks
// defined here, not by the agent — their purpose, their questions, their result
// and what the app does with it. The agent supplies only the content. They share
// one loop: Approve (the result, returned and used), Revise with my notes (the
// agent redrafts and asks again — at most REVISION_ROUNDS times, then it stops
// redrafting and asks what's wrong), Reject / Not now (nothing changes, the
// agent gets the reason). A new methodological question is a new exchange here,
// never a new kind of card (user, 2026-11-05). Frame comes with PR A.

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

// ── Source pick: one need, the sources the scout found ─────────────────────

export interface SourceOption {
  name: string
  /** Coverage, terms and fit, in a line. */
  detail: string
}
const sourceLabel = (s: SourceOption) => `${s.name} — ${s.detail}`

export function sourceCard(input: { need: string; why?: string; sources: SourceOption[]; recommended?: string }): Card {
  const options = input.sources.map(sourceLabel)
  const rec = input.sources.find((s) => s.name === input.recommended)
  return {
    title: `Which source for ${input.need}?`,
    questions: [
      {
        id: 'source',
        kind: 'one',
        question: `The source for ${input.need}`,
        why: input.why || 'What the scout found for this need; the one you pick is what the scraper fetches.',
        options: rec ? [sourceLabel(rec), ...options.filter((o) => o !== sourceLabel(rec))] : options,
        ...(rec ? { recommended: sourceLabel(rec), selected: sourceLabel(rec) } : {}),
        neither: true,
        required: true,
      },
    ],
    buttons: ['Use it', 'Not now'],
  }
}
export function sourceOutcome(card: Card, a: CardAnswer, sources: SourceOption[]): Outcome<{ source: string | null; neither: boolean }> {
  const r = a.replies.source
  const out = settle('source', new Map(), card, a, () => {
    if (r?.kind !== 'one' || r.neither || !r.choice) return { source: null, neither: true }
    return { source: sources.find((s) => sourceLabel(s) === r.choice)?.name ?? r.choice, neither: false }
  })
  if (out.decision === 'approved' && out.value?.neither) out.next = 'None of these: read the comments for what the user wants instead (another source, a proxy, skipping it).'
  return out
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

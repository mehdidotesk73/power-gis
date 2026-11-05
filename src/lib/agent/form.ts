// Question cards (docs/agents.md, *Question cards and exchanges*; user, 2026-11-05).
//
// A card holds 1–3 questions that belong together and ends with one pair of
// buttons that answers it all at once, so the agent gets the answers together,
// in context. Every question has the same frame — the question, why it's asked
// and what the answer changes, its controls, a comments box — and is one of
// three kinds:
//   answer  — the agent's own considered response (or a plan, a brief), edited by
//             the user as it stands; never an empty box
//   one     — radio buttons, the agent's options, its recommendation first and
//             marked; plus "Neither (see comments)" when an answer outside them
//             is plausible
//   several — checkboxes, some may start ticked (editing a selection)
// A card with no questions is a plain yes / no (or go / no-go…) question with one
// comments box. Exchanges (exchanges.ts) build cards from fixed shapes and may
// add "Revise with my notes" between the pair. Pure: the card is
// components/agent/AskCard.vue.

interface QuestionBase {
  id: string
  /** The question, one sentence. */
  question: string
  /** Why it's asked and what the answer changes. */
  why?: string
  /** The first button waits for it (an answer must keep some text, a choice needs a pick). */
  required?: boolean
}
export interface AnswerQuestion extends QuestionBase {
  kind: 'answer'
  /** The drafted response the user edits. */
  text: string
}
export interface OneQuestion extends QuestionBase {
  kind: 'one'
  /** The options, the recommended one first. */
  options: string[]
  /** One of the options, shown first and marked. */
  recommended?: string
  /** Offer "Neither (see comments)". */
  neither?: boolean
  /** The option picked to start with (the recommended one by default). */
  selected?: string
}
export interface SeveralQuestion extends QuestionBase {
  kind: 'several'
  options: string[]
  /** Options ticked to start with. */
  selected?: string[]
}
export type Question = AnswerQuestion | OneQuestion | SeveralQuestion

export interface Card {
  /** What the card asks, one sentence (the whole question when there are no questions). */
  title: string
  /** What the agent found or proposes, in a few lines. */
  context?: string
  questions: Question[]
  /** The pair that answers the card: the first goes ahead, the second doesn't. */
  buttons: [string, string]
  /** An exchange's "Revise with my notes", shown between the pair. */
  revise?: boolean
}

/** One question's reply. An unchanged answer isn't sent back in full (a long plan approved as it is costs no tokens). */
export type Reply =
  | { kind: 'answer'; edited: boolean; text?: string; comments?: string }
  | { kind: 'one'; choice: string | null; neither?: true; comments?: string }
  | { kind: 'several'; choices: string[]; comments?: string }

export interface CardAnswer {
  /** The button pressed: one of the pair, REVISE, or STOPPED. */
  button: string
  /** By question id. */
  replies: Record<string, Reply>
  /** The card's own comments box (a card with no questions). */
  comments?: string
}

/** What the user's Stop answers a waiting card with. */
export const STOPPED = 'Stopped'
/** The exchanges' third button. */
export const REVISE = 'Revise with my notes'
export const NEITHER = 'Neither (see comments)'

export const LIMITS = { questions: 3, options: 20, text: 8000, line: 300 }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const filled = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0

/** The options with the recommended one first (if any). */
const ordered = (options: string[], recommended?: string) => (recommended ? [recommended, ...options.filter((o) => o !== recommended)] : options)

/** ask_user's input as a card, or the first problem with it. */
export function readCard(input: Record<string, unknown>): Card | string {
  const { title, context, questions = [], buttons } = input
  if (!filled(title)) return '`title` is required: the question the card asks, one sentence'
  if (context !== undefined && typeof context !== 'string') return '`context` must be text'
  if (!Array.isArray(questions)) return '`questions` must be a list'
  if (questions.length > LIMITS.questions) return `At most ${LIMITS.questions} questions on a card: ask the rest on the next one`
  const out: Question[] = []
  for (const [i, q] of questions.entries()) {
    const at = `questions[${i}]`
    if (!isObj(q)) return `${at} must be an object`
    if (!filled(q.question)) return `${at}: "question" is required`
    if (q.question.length > LIMITS.line) return `${at}: "question" is too long (one sentence; the rest goes in "why")`
    const base = { id: `q${i + 1}`, question: q.question.trim(), ...(filled(q.why) ? { why: q.why.trim() } : {}), ...(q.required === true ? { required: true } : {}) }
    if (q.kind === 'answer') {
      // Never an empty box: the agent writes its own response for the user to edit.
      if (!filled(q.text)) return `${at}: an "answer" needs "text": your own considered response (or the plan, the brief) for the user to edit`
      if (q.text.length > LIMITS.text) return `${at}: "text" is too long`
      out.push({ ...base, kind: 'answer', text: q.text.trim() })
      continue
    }
    if (q.kind !== 'one' && q.kind !== 'several') return `${at}: "kind" must be "answer", "one" or "several"`
    if (!strings(q.options)) return `${at}: "options" must be a list of text`
    const options = q.options.map((o) => o.trim()).filter(Boolean)
    if (options.length < 2) return `${at}: a choice needs at least two options`
    if (options.length > LIMITS.options) return `${at}: at most ${LIMITS.options} options`
    if (new Set(options).size !== options.length) return `${at}: options must differ`
    if (q.kind === 'one') {
      const recommended = filled(q.recommended) && options.includes(q.recommended.trim()) ? q.recommended.trim() : undefined
      const selected = filled(q.selected) && options.includes(q.selected.trim()) ? q.selected.trim() : recommended
      out.push({ ...base, kind: 'one', options: ordered(options, recommended), ...(recommended ? { recommended } : {}), ...(q.neither === false ? {} : { neither: true }), ...(selected ? { selected } : {}) })
    } else {
      const selected = strings(q.selected) ? q.selected.map((s) => s.trim()).filter((s) => options.includes(s)) : []
      out.push({ ...base, kind: 'several', options, ...(selected.length ? { selected } : {}) })
    }
  }
  const pair = buttons === undefined || (Array.isArray(buttons) && buttons.length === 0) ? (out.length ? ['Submit', 'Cancel'] : ['Yes', 'No']) : buttons
  if (!strings(pair) || pair.length !== 2 || !pair.every(filled)) return '`buttons` must be a pair: what goes ahead first, then what doesn\'t (Submit / Cancel, Yes / No, Approve / Reject, Go / No-go)'
  if (pair[0].trim() === pair[1].trim()) return 'The two buttons must differ'
  return { title: title.trim(), ...(filled(context) ? { context: context.trim() } : {}), questions: out, buttons: [pair[0].trim(), pair[1].trim()] }
}

// ── the card's state, and the answer it makes ──────────────────────────────

/** What a question's controls hold while the user works on the card. */
export interface QuestionState {
  text: string
  /** One: the option picked, NEITHER, or null. */
  choice: string | null
  choices: string[]
  comments: string
}
export function initialState(card: Card): Record<string, QuestionState> {
  return Object.fromEntries(
    card.questions.map((q) => [
      q.id,
      { text: q.kind === 'answer' ? q.text : '', choice: q.kind === 'one' ? (q.selected ?? null) : null, choices: q.kind === 'several' ? [...(q.selected ?? [])] : [], comments: '' },
    ]),
  )
}

/** The questions the first button still waits for, by their question. */
export function missingRequired(card: Card, state: Record<string, QuestionState>): string[] {
  return card.questions
    .filter((q) => {
      const s = state[q.id]
      if (!q.required || !s) return false
      if (q.kind === 'answer') return !s.text.trim()
      // Neither counts as answered once its comments say what instead.
      if (q.kind === 'one') return s.choice === null || (s.choice === NEITHER && !s.comments.trim())
      return !s.choices.length
    })
    .map((q) => q.question)
}

/** The card's answer from its state. */
export function cardAnswer(card: Card, state: Record<string, QuestionState>, button: string, comments = ''): CardAnswer {
  const replies: Record<string, Reply> = {}
  for (const q of card.questions) {
    const s = state[q.id]
    const note = s?.comments.trim() ? { comments: s.comments.trim() } : {}
    if (q.kind === 'answer') {
      const text = (s?.text ?? q.text).trim()
      replies[q.id] = text === q.text.trim() ? { kind: 'answer', edited: false, ...note } : { kind: 'answer', edited: true, text, ...note }
    } else if (q.kind === 'one') {
      const neither = s?.choice === NEITHER
      replies[q.id] = { kind: 'one', choice: neither || !s?.choice ? null : s.choice, ...(neither ? { neither: true as const } : {}), ...note }
    } else replies[q.id] = { kind: 'several', choices: q.options.filter((o) => s?.choices.includes(o)), ...note }
  }
  return { button, replies, ...(comments.trim() ? { comments: comments.trim() } : {}) }
}

/** The answer as the agent reads it: each reply next to its question; an unchanged draft as just "edited: false". */
export function answerForAgent(card: Card, a: CardAnswer): Record<string, unknown> {
  return {
    button: a.button,
    ...(card.questions.length
      ? {
          answers: card.questions.map((q) => {
            const r = a.replies[q.id]
            if (!r) return { question: q.question, answered: false }
            const { kind: _kind, ...rest } = r
            return { question: q.question, ...rest }
          }),
        }
      : {}),
    ...(a.comments ? { comments: a.comments } : {}),
  }
}

/** One line for the chat's step: the button, then each reply in a few words. */
export function answerSummary(card: Card, a: CardAnswer): string {
  const parts = card.questions.flatMap((q) => {
    const r = a.replies[q.id]
    if (!r) return []
    const label = q.question.length > 40 ? `${q.question.slice(0, 40)}…` : q.question
    const said =
      r.kind === 'answer' ? (r.edited ? 'edited' : 'as proposed') : r.kind === 'one' ? (r.neither ? 'neither' : (r.choice ?? '—')) : r.choices.join(', ') || 'none'
    return [`${label} ${said.length > 60 ? `${said.slice(0, 60)}…` : said}${r.comments ? ' (+ comments)' : ''}`]
  })
  return [a.button, ...parts, ...(a.comments ? ['comments'] : [])].join(' · ')
}

/** Every comment on the card, for the agent's attention. */
export const commentsOf = (a: CardAnswer): string[] => [...Object.values(a.replies).flatMap((r) => (r.comments ? [r.comments] : [])), ...(a.comments ? [a.comments] : [])]

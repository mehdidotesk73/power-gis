// What the assistant asks the user (ask_user): a question, optional details,
// and a small form built from a few kinds of field — a text box (one line or
// several, optionally filled in for the user to review and edit), a choice
// (one or several of the agent's options, optionally plus the user's own
// answer) — and the buttons that answer it. The chat shows it as a card; the
// answer goes back to the agent as the button pressed and each field's value.
// Pure: the card lives in components/agent/AskCard.vue.

export interface TextField {
  id: string
  kind: 'text'
  label: string
  /** Filled in for the user to review and edit (a plan, a brief). */
  value?: string
  placeholder?: string
  /** Several lines (a plan, notes) rather than one. */
  multiline?: boolean
  required?: boolean
}

export interface ChoiceField {
  id: string
  kind: 'choice'
  label: string
  options: string[]
  /** Any number of the options rather than one. */
  multiple?: boolean
  /** The user may also write their own answer. */
  other?: boolean
  /** Options chosen to start with. */
  selected?: string[]
  required?: boolean
}

export type FormField = TextField | ChoiceField

export interface Form {
  question: string
  details?: string
  fields: FormField[]
  /** The answers, first = the main one (it alone needs the required fields). */
  buttons: string[]
}

export interface FormAnswer {
  /** The button pressed (or "Stopped" when the user stopped the assistant). */
  button: string
  /** Each field's value: text, or the chosen options (with the user's own answer last). */
  values: Record<string, string | string[]>
}

/** Answers the user's Stop gives a waiting question. */
export const STOPPED = 'Stopped'

export const LIMITS = { fields: 8, options: 20, buttons: 4, label: 120, text: 8000 }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const nonEmpty = (s: string) => s.trim().length > 0

/** The tool input as a form, or the first problem with it. */
export function readForm(input: Record<string, unknown>): Form | string {
  const { question, details, fields = [], buttons } = input
  if (typeof question !== 'string' || !nonEmpty(question)) return '`question` is required'
  if (details !== undefined && typeof details !== 'string') return '`details` must be text'
  if (!Array.isArray(fields)) return '`fields` must be a list'
  if (fields.length > LIMITS.fields) return `At most ${LIMITS.fields} fields`
  const out: FormField[] = []
  const ids = new Set<string>()
  for (const [i, f] of fields.entries()) {
    const at = `fields[${i}]`
    if (!isObj(f)) return `${at} must be an object`
    if (typeof f.id !== 'string' || !nonEmpty(f.id)) return `${at}: "id" is required`
    if (ids.has(f.id)) return `${at}: id "${f.id}" is used twice`
    ids.add(f.id)
    if (typeof f.label !== 'string' || !nonEmpty(f.label)) return `${at}: "label" is required`
    if (f.label.length > LIMITS.label) return `${at}: "label" is too long (a few words; put explanations in details)`
    const required = f.required === true
    if (f.kind === 'text') {
      if (f.value !== undefined && typeof f.value !== 'string') return `${at}: "value" must be text`
      if (typeof f.value === 'string' && f.value.length > LIMITS.text) return `${at}: "value" is too long`
      if (f.placeholder !== undefined && typeof f.placeholder !== 'string') return `${at}: "placeholder" must be text`
      out.push({
        id: f.id,
        kind: 'text',
        label: f.label.trim(),
        ...(typeof f.value === 'string' ? { value: f.value } : {}),
        ...(typeof f.placeholder === 'string' && f.placeholder ? { placeholder: f.placeholder } : {}),
        ...(f.multiline === true ? { multiline: true } : {}),
        ...(required ? { required } : {}),
      })
    } else if (f.kind === 'choice') {
      const given = f.options ?? []
      if (!strings(given)) return `${at}: "options" must be a list of text`
      const options = given.map((o) => o.trim()).filter(nonEmpty)
      if (!options.length && f.other !== true) return `${at}: a choice needs options (or "other": true)`
      if (options.length > LIMITS.options) return `${at}: at most ${LIMITS.options} options`
      if (new Set(options).size !== options.length) return `${at}: options must differ`
      if (f.selected !== undefined && !strings(f.selected)) return `${at}: "selected" must be a list of options`
      const selected = (f.selected ?? []).filter((s) => options.includes(s))
      if (f.multiple !== true && selected.length > 1) return `${at}: a single choice can start with at most one option selected`
      out.push({
        id: f.id,
        kind: 'choice',
        label: f.label.trim(),
        options,
        ...(f.multiple === true ? { multiple: true } : {}),
        ...(f.other === true ? { other: true } : {}),
        ...(selected.length ? { selected } : {}),
        ...(required ? { required } : {}),
      })
    } else return `${at}: "kind" must be "text" or "choice"`
  }
  const given: unknown = buttons === undefined ? (out.length ? ['Submit'] : ['Approve', 'Reject']) : buttons
  if (!strings(given)) return '`buttons` must be a list of text'
  const shown = given.map((b) => b.trim()).filter(nonEmpty)
  if (!shown.length) return '`buttons` needs at least one'
  if (shown.length > LIMITS.buttons) return `At most ${LIMITS.buttons} buttons`
  if (new Set(shown).size !== shown.length) return 'Buttons must differ'
  return { question: question.trim(), ...(typeof details === 'string' && nonEmpty(details) ? { details: details.trim() } : {}), fields: out, buttons: shown }
}

/** What each field starts as on the card. */
export function initialValues(form: Form): Record<string, string | string[]> {
  return Object.fromEntries(form.fields.map((f) => [f.id, f.kind === 'text' ? (f.value ?? '') : [...(f.selected ?? [])]]))
}

/** The value a field answers with: text trimmed; chosen options in their order, the user's own answer last. */
export function fieldValue(f: FormField, value: string | string[], other = ''): string | string[] {
  if (f.kind === 'text') return typeof value === 'string' ? value.trim() : ''
  const chosen = (Array.isArray(value) ? value : []).filter((v) => f.options.includes(v))
  const own = f.other ? other.trim() : ''
  const ordered = f.options.filter((o) => chosen.includes(o))
  return f.multiple ? (own ? [...ordered, own] : ordered) : own && !ordered.length ? [own] : ordered.slice(0, 1)
}

/** The required fields still empty, by label (they hold back the main button only). */
export function missingRequired(form: Form, values: Record<string, string | string[]>): string[] {
  return form.fields.filter((f) => f.required && !(Array.isArray(values[f.id]) ? (values[f.id] as string[]).length : String(values[f.id] ?? '').trim())).map((f) => f.label)
}

/** One line for the chat's step and the answered card: the button, then each answer. */
export function answerSummary(form: Form, a: FormAnswer): string {
  const parts = form.fields.flatMap((f) => {
    const v = a.values[f.id]
    const text = Array.isArray(v) ? v.join(', ') : (v ?? '')
    if (!text) return []
    // A long text answer (a reviewed plan) is summed up by whether it changed.
    if (f.kind === 'text' && f.value !== undefined && text.length > 60) return [`${f.label}: ${text === f.value.trim() ? 'as proposed' : 'edited'}`]
    return [`${f.label}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`]
  })
  return [a.button, ...parts].join(' · ')
}

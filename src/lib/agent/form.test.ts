import { describe, expect, it } from 'vitest'
import { answerSummary, fieldValue, initialValues, missingRequired, readForm, type Form } from './form'

const form = (input: Record<string, unknown>) => readForm(input) as Form

describe('ask_user forms', () => {
  it('defaults the buttons: Approve / Reject without fields, Submit with them', () => {
    expect(form({ question: 'Build it?' }).buttons).toEqual(['Approve', 'Reject'])
    expect(form({ question: 'Name?', fields: [{ id: 'n', kind: 'text', label: 'Name' }] }).buttons).toEqual(['Submit'])
  })

  it('checks every field and names the problem', () => {
    expect(readForm({})).toBe('`question` is required')
    expect(readForm({ question: 'Q', fields: [{ id: 'a', kind: 'text', label: 'A' }, { id: 'a', kind: 'text', label: 'B' }] })).toMatch(/used twice/)
    expect(readForm({ question: 'Q', fields: [{ id: 'a', kind: 'slider', label: 'A' }] })).toMatch(/"kind"/)
    expect(readForm({ question: 'Q', fields: [{ id: 'a', kind: 'choice', label: 'A', options: ['x', 'x'] }] })).toMatch(/differ/)
    expect(readForm({ question: 'Q', fields: [{ id: 'a', kind: 'choice', label: 'A', options: ['x', 'y'], selected: ['x', 'y'] }] })).toMatch(/at most one/)
    expect(readForm({ question: 'Q', buttons: [] })).toMatch(/at least one/)
    expect(readForm({ question: 'Q', buttons: ['a', 'b', 'c', 'd', 'e'] })).toMatch(/At most 4/)
    // Only the user's own answer is fine.
    expect(form({ question: 'Q', fields: [{ id: 'a', kind: 'choice', label: 'A', other: true }] }).fields[0]).toMatchObject({ options: [], other: true })
  })

  it('gives an empty multiline box a hint, so it never reads as a missing draft', () => {
    expect(form({ question: 'Approve?', fields: [{ id: 'n', kind: 'text', label: 'Notes', multiline: true }] }).fields[0]).toMatchObject({ placeholder: 'Write here…' })
    expect(form({ question: 'Notes?', fields: [{ id: 'n', kind: 'text', label: 'Notes', multiline: true, placeholder: 'Anything else' }] }).fields[0]).toMatchObject({ placeholder: 'Anything else' })
    expect(form({ question: 'Plan?', fields: [{ id: 'p', kind: 'text', label: 'Plan', multiline: true, value: 'Clean, then map.' }] }).fields[0]).not.toHaveProperty('placeholder')
  })

  it('answers with the chosen options in order and the own answer last; a single choice prefers an option', () => {
    const multi = form({ question: 'Q', fields: [{ id: 'y', kind: 'choice', label: 'Years', options: ['2022', '2023', '2024'], multiple: true, other: true }] }).fields[0]
    expect(fieldValue(multi, ['2024', '2022', 'nope'], ' 2019 ')).toEqual(['2022', '2024', '2019'])
    const single = form({ question: 'Q', fields: [{ id: 's', kind: 'choice', label: 'Source', options: ['Census', 'Zillow'], other: true }] }).fields[0]
    expect(fieldValue(single, ['Zillow'], 'my own')).toEqual(['Zillow'])
    expect(fieldValue(single, [], 'my own')).toEqual(['my own'])
    const text = form({ question: 'Q', fields: [{ id: 't', kind: 'text', label: 'T' }] }).fields[0]
    expect(fieldValue(text, '  hi  ')).toBe('hi')
  })

  it('starts from the given values, holds back the main button for required fields, and sums up the answer', () => {
    const f = form({
      question: 'Review the plan',
      fields: [
        { id: 'plan', kind: 'text', label: 'Plan', value: 'Clean, join, then map the median rent per county.', multiline: true, required: true },
        { id: 'level', kind: 'choice', label: 'Level', options: ['County', 'State'], multiple: true, selected: ['County'] },
      ],
      buttons: ['Build it', 'Not now'],
    })
    const start = initialValues(f)
    expect(start).toEqual({ plan: 'Clean, join, then map the median rent per county.', level: ['County'] })
    expect(missingRequired(f, { ...start, plan: '  ' })).toEqual(['Plan'])
    expect(answerSummary(f, { button: 'Build it', values: { plan: start.plan, level: ['County', 'State'] } })).toBe('Build it · Plan: Clean, join, then map the median rent per county. · Level: County, State')
    const long = 'x'.repeat(80)
    const g = form({ question: 'Q', fields: [{ id: 'p', kind: 'text', label: 'Plan', value: long }] })
    expect(answerSummary(g, { button: 'Submit', values: { p: long } })).toBe('Submit · Plan: as proposed')
    expect(answerSummary(g, { button: 'Submit', values: { p: `${long}!` } })).toBe('Submit · Plan: edited')
  })

  it('adds a Notes box to every card, and Revise with my notes to one with a draft', async () => {
    const { withNotes, REVISE } = await import('./form')
    const plain = withNotes({ question: 'Go?', fields: [], buttons: ['Approve', 'Reject'] })
    expect(plain.fields.map((f) => f.id)).toEqual(['notes'])
    expect(plain.buttons).toEqual(['Approve', 'Reject']) // nothing drafted to revise
    const draft = withNotes({ question: 'Framing', fields: [{ id: 'framing', kind: 'text', label: 'Framing', value: 'A retirement score…', multiline: true }], buttons: ['Approve'] })
    expect(draft.buttons).toEqual(['Approve', REVISE])
    // The assistant's own notes box is kept; a full card gets none; four buttons leave no room for Revise.
    expect(withNotes({ question: 'Q', fields: [{ id: 'notes', kind: 'text', label: 'Mine' }], buttons: ['OK'] }).fields).toHaveLength(1)
    const full = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, kind: 'text' as const, label: 'x', value: 'y' }))
    expect(withNotes({ question: 'Q', fields: full, buttons: ['A', 'B', 'C', 'D'] })).toMatchObject({ fields: full, buttons: ['A', 'B', 'C', 'D'] })
  })
})

import { describe, expect, it } from 'vitest'
import { answerForAgent, answerSummary, cardAnswer, initialState, missingRequired, NEITHER, readCard, type Card } from './form'

const card = (input: Record<string, unknown>) => readCard(input) as Card
const q = (x: Record<string, unknown>) => ({ why: '', text: '', options: [], recommended: '', neither: false, selected: [], required: false, ...x })

describe('question cards', () => {
  it('default pairs: Submit / Cancel with questions, Yes / No without', () => {
    expect(card({ title: 'Count the overseas regions in France?' }).buttons).toEqual(['Yes', 'No'])
    expect(card({ title: 'Settle the plan', questions: [q({ kind: 'answer', question: 'The plan', text: 'Clean, join, map.' })] }).buttons).toEqual(['Submit', 'Cancel'])
    expect(card({ title: 'Go?', buttons: ['Go', 'No-go'] }).buttons).toEqual(['Go', 'No-go'])
  })

  it('refuses what the format rules out, and says how to fix it', () => {
    expect(readCard({})).toMatch(/title/)
    expect(readCard({ title: 'T', questions: [1, 2, 3, 4].map(() => q({ kind: 'answer', question: 'Q', text: 'x' })) })).toMatch(/At most 3/)
    expect(readCard({ title: 'T', questions: [q({ kind: 'answer', question: 'Explain?', text: '' })] })).toMatch(/your own considered response/)
    expect(readCard({ title: 'T', questions: [q({ kind: 'one', question: 'Pick', options: ['only'] })] })).toMatch(/at least two/)
    expect(readCard({ title: 'T', questions: [q({ kind: 'slider', question: 'Q' })] })).toMatch(/"kind"/)
    expect(readCard({ title: 'T', buttons: ['Yes', 'No', 'Maybe'] })).toMatch(/pair/)
    expect(readCard({ title: 'T', buttons: ['Yes', 'Yes'] })).toMatch(/differ/)
  })

  it('puts the recommended option first, picks it to start, and offers Neither unless told not to', () => {
    const c = card({ title: 'Overseas regions', questions: [q({ kind: 'one', question: 'What to do with them?', options: ['Leave them out', 'Count them in France'], recommended: 'Count them in France', neither: true })] })
    expect(c.questions[0]).toMatchObject({ options: ['Count them in France', 'Leave them out'], recommended: 'Count them in France', selected: 'Count them in France', neither: true })
    const exhaustive = card({ title: 'T', questions: [q({ kind: 'one', question: 'Q', options: ['a', 'b'], neither: false })] })
    expect(exhaustive.questions[0]).not.toHaveProperty('neither')
  })

  it('answers a three-question card in one go; an unchanged draft comes back as just edited: false', () => {
    const c = card({
      title: 'Frame it',
      questions: [
        q({ kind: 'answer', question: 'How I would frame it', text: 'Where therapy practices are viable.' }),
        q({ kind: 'several', question: 'Components', options: ['Demand', 'Fees', 'Providers'], selected: ['Demand', 'Fees', 'Providers'] }),
        q({ kind: 'one', question: 'Level', options: ['County', 'State'], recommended: 'County', neither: true }),
      ],
    })
    const s = initialState(c)
    s.q2.choices = ['Demand', 'Providers']
    s.q2.comments = 'Fees are a proxy at best'
    s.q3.choice = NEITHER
    s.q3.comments = 'Metro areas'
    const a = cardAnswer(c, s, 'Submit')
    expect(answerForAgent(c, a)).toEqual({
      button: 'Submit',
      answers: [
        { question: 'How I would frame it', edited: false },
        { question: 'Components', choices: ['Demand', 'Providers'], comments: 'Fees are a proxy at best' },
        { question: 'Level', choice: null, neither: true, comments: 'Metro areas' },
      ],
    })
    expect(answerSummary(c, a)).toContain('as proposed')
    s.q1.text = 'Where a new practice would find clients.'
    expect(cardAnswer(c, s, 'Submit').replies.q1).toEqual({ kind: 'answer', edited: true, text: 'Where a new practice would find clients.' })
  })

  it('holds back only the first button for required questions; Neither needs its comments', () => {
    const c = card({ title: 'T', questions: [q({ kind: 'one', question: 'Pick', options: ['a', 'b'], neither: true, required: true })] })
    const s = initialState(c)
    expect(missingRequired(c, s)).toEqual(['Pick'])
    s.q1.choice = NEITHER
    expect(missingRequired(c, s)).toEqual(['Pick'])
    s.q1.comments = 'c instead'
    expect(missingRequired(c, s)).toEqual([])
  })

  it('a plain yes / no card carries its own comments', () => {
    const c = card({ title: 'Merge the overseas regions into France?' })
    const a = cardAnswer(c, {}, 'No', 'Keep Guadeloupe separate')
    expect(answerForAgent(c, a)).toEqual({ button: 'No', comments: 'Keep Guadeloupe separate' })
  })
})

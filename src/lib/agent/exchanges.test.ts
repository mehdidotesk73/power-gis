import { describe, expect, it } from 'vitest'
import { planCard, planOutcome, REVISION_ROUNDS, runCard, runOutcome, sourceCard, sourceOutcome, type Rounds } from './exchanges'
import { cardAnswer, initialState, NEITHER, REVISE } from './form'

describe('exchanges', () => {
  it('Plan: approved as is (nothing sent back), edited (the new plan), revised at most twice', () => {
    const rounds: Rounds = new Map()
    const card = planCard({ plan: 'Clean, join, map.' }, rounds)
    expect(card.revise).toBe(true)
    expect(card.buttons).toEqual(['Approve', 'Reject'])
    const s = initialState(card)
    expect(planOutcome(card, cardAnswer(card, s, 'Approve'), rounds)).toMatchObject({ decision: 'approved', value: { edited: false } })
    s.plan.text = 'Clean, join, then map by state.'
    expect(planOutcome(card, cardAnswer(card, s, 'Approve'), rounds)).toMatchObject({ decision: 'approved', value: { edited: true, plan: 'Clean, join, then map by state.' } })

    // Two revisions, then no Revise button: the agent is told to ask what's wrong instead.
    for (let n = 1; n <= REVISION_ROUNDS; n++) {
      const c = planCard({ plan: `draft ${n}` }, rounds)
      expect(c.revise).toBe(true)
      const out = planOutcome(c, cardAnswer(c, initialState(c), REVISE), rounds)
      expect(out.decision).toBe('revise')
      if (n === REVISION_ROUNDS) expect(out.next).toMatch(/last revision round/)
    }
    expect(planCard({ plan: 'draft 3' }, rounds).revise).toBeUndefined()
    // Any other answer starts the count again.
    const c = planCard({ plan: 'draft 3' }, rounds)
    planOutcome(c, cardAnswer(c, initialState(c), 'Reject'), rounds)
    expect(planCard({ plan: 'draft 4' }, rounds).revise).toBe(true)
  })

  it('Source pick: the recommended source first; Neither returns no source and points at the comments', () => {
    const sources = [
      { name: 'Census ACS', detail: 'every county, 2023, public domain' },
      { name: 'HUD FMR', detail: 'every county, 2024, public domain, rents only' },
    ]
    const card = sourceCard({ need: 'county rents', sources, recommended: 'HUD FMR' })
    expect(card.questions[0]).toMatchObject({ kind: 'one', neither: true, recommended: 'HUD FMR — every county, 2024, public domain, rents only' })
    expect((card.questions[0] as { options: string[] }).options[0]).toMatch(/^HUD FMR/)
    const s = initialState(card)
    expect(sourceOutcome(card, cardAnswer(card, s, 'Use it'), sources)).toMatchObject({ decision: 'approved', value: { source: 'HUD FMR', neither: false } })
    s.source.choice = NEITHER
    s.source.comments = 'Zillow if its terms allow'
    expect(sourceOutcome(card, cardAnswer(card, s, 'Use it'), sources)).toMatchObject({ value: { source: null, neither: true }, comments: ['Zillow if its terms allow'], next: expect.stringMatching(/comments/) })
  })

  it('Run: the brief as edited, the cap picked or written in the comments with Neither', () => {
    const card = runCard({ role: 'scraper', brief: 'Fetch rents.', caps: ['$0.50', '$2'], recommended: 'Recommended: $1' })
    expect(card.buttons).toEqual(['Send the scraper', 'Not now'])
    const read = (v: string) => {
      const m = v.match(/(\d+(?:\.\d+)?)/)
      return m ? Number(m[1]) : undefined
    }
    const s = initialState(card)
    expect(runOutcome(card, cardAnswer(card, s, 'Send the scraper'), read)).toMatchObject({ decision: 'approved', value: { brief: 'Fetch rents.', cap: 1 } })
    s.brief.text = 'Fetch rents, 2024 only.'
    s.cap.choice = NEITHER
    s.cap.comments = '3 dollars'
    expect(runOutcome(card, cardAnswer(card, s, 'Send the scraper'), read)).toMatchObject({ value: { brief: 'Fetch rents, 2024 only.', cap: 3 } })
    expect(runOutcome(card, cardAnswer(card, s, 'Not now'), read)).toMatchObject({ decision: 'declined' })
  })
})

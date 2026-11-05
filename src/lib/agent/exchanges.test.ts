import { describe, expect, it } from 'vitest'
import { frameCard, frameOutcome, frameSection, planCard, planOutcome, REVISION_ROUNDS, runCard, runOutcome, sourceCard, sourceOutcome, withFrame, type Rounds } from './exchanges'
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

  it('Source pick: several sources, the recommended ones ticked, and the combination to edit', () => {
    const sources = [
      { name: 'OECD wages', detail: '38 countries, USD PPP, average annual' },
      { name: 'ILOSTAT earnings', detail: '~174 countries, nominal USD, average monthly' },
    ]
    const card = sourceCard({ need: 'pay per country', sources, recommended: ['OECD wages', 'ILOSTAT earnings'], combination: 'OECD anchors; ILOSTAT fills in, calibrated per country with the price-level ratio.' })
    expect(card.questions.map((q) => q.kind)).toEqual(['several', 'answer'])
    expect((card.questions[0] as { selected: string[] }).selected).toHaveLength(2)
    const s = initialState(card)
    s.combination.text = 'OECD anchors; ILOSTAT fills in, calibrated per country with the World Bank price-level ratio.'
    expect(sourceOutcome(card, cardAnswer(card, s, 'Use these'), sources)).toMatchObject({
      decision: 'approved',
      value: { sources: ['OECD wages', 'ILOSTAT earnings'], combinationEdited: true, combination: expect.stringContaining('World Bank') },
    })
    // Several kept without a combination: the agent is told to say how they combine.
    const bare = sourceCard({ need: 'pay', sources, recommended: ['OECD wages'] })
    const b = initialState(bare)
    b.sources.choices = bare.questions[0].kind === 'several' ? [...bare.questions[0].options] : []
    expect(sourceOutcome(bare, cardAnswer(bare, b, 'Use these'), sources).next).toMatch(/how they combine/)
    // None kept: the comments say what instead.
    b.sources.choices = []
    b.sources.comments = 'Use the World Bank instead'
    expect(sourceOutcome(bare, cardAnswer(bare, b, 'Use these'), sources)).toMatchObject({ value: { sources: [] }, next: expect.stringMatching(/None of these/) })
  })

  it('Frame: the framing, components with postures, the measure decision; saved as About\'s Study frame', () => {
    const rounds: Rounds = new Map()
    const input = {
      framing: 'The countries where a typical full-time worker earns the most in a year.',
      components: [
        { name: 'Average annual wage', posture: 'anchor + proxy' as const, note: 'OECD, filled in from ILOSTAT', key: true },
        { name: 'Hours worked', posture: 'exact' as const, key: false },
      ],
      decision: { question: 'In what money?', options: ['Market exchange rates', 'Buying power (PPP)'], recommended: 'Buying power (PPP)' },
    }
    const card = frameCard(input, rounds)
    expect(card.questions.map((q) => q.kind)).toEqual(['answer', 'several', 'one'])
    expect(card.questions[2]).toMatchObject({ options: ['Buying power (PPP)', 'Market exchange rates'], neither: true })
    expect(card.revise).toBe(true)
    const out = frameOutcome(card, cardAnswer(card, initialState(card), 'Approve'), rounds, input)
    expect(out.value).toMatchObject({ edited: false, decision: { choice: 'Buying power (PPP)' }, components: [{ name: 'Average annual wage', kept: true }, { name: 'Hours worked', kept: false }] })
    const section = frameSection(out.value!)
    expect(section).toContain('## Study frame')
    expect(section).toContain('**In what money?** Buying power (PPP)')
    expect(section).toContain('- Average annual wage (anchor + proxy: OECD, filled in from ILOSTAT)')
    expect(section).toContain('**Left out:** Hours worked')
    // Added at the top of About; a new frame replaces the old section and keeps the rest.
    const about = withFrame('## Sources\nNotes the user wrote.', section)
    expect(about.startsWith('## Study frame')).toBe(true)
    const again = withFrame(about, '## Study frame\n\nRevised.')
    expect(again).toBe('## Study frame\n\nRevised.\n\n## Sources\nNotes the user wrote.')
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

import { describe, expect, it } from 'vitest'
import { ellipsize, wrapLines } from './textFit'

const measure = (t: string) => t.length // one unit per character

describe('fitting text', () => {
  it('ellipsizes only what does not fit', () => {
    expect(ellipsize('County', 10, measure)).toBe('County')
    expect(ellipsize('County metrics and scores', 10, measure)).toBe('County me…')
  })

  it('wraps at spaces into a number of lines, ending in an ellipsis when text is left', () => {
    expect(wrapLines('Clean county income', 12, 2, measure)).toEqual(['Clean county', 'income'])
    expect(wrapLines('2a Join shapes with income and education', 12, 2, measure)).toEqual(['2a Join', 'shapes with…'])
    expect(wrapLines('Short', 12, 2, measure)).toEqual(['Short'])
    expect(wrapLines('Supercalifragilistic word', 8, 2, measure)).toEqual(['Superca…', 'word'])
    expect(wrapLines('', 8, 2, measure)).toEqual([])
  })
})

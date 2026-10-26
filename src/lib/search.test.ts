import { describe, expect, it } from 'vitest'
import { editDistance, search } from './search'

const names = ['Duke Energy Carolinas, LLC', 'Duke Energy Florida, LLC', 'Pee Dee Electric Coop', 'Carolina Power', 'Bédford Light']
const find = (q: string, limit?: number) => search(names, q, (n) => n, limit)

describe('search', () => {
  it('requires every word and ranks prefix matches first', () => {
    expect(find('duke carolinas')).toEqual(['Duke Energy Carolinas, LLC'])
    expect(find('carolina')[0]).toBe('Carolina Power')
    expect(find('dee')).toEqual(['Pee Dee Electric Coop'])
  })

  it('ignores case and accents, and returns nothing for an empty query', () => {
    expect(find('BEDFORD')).toEqual(['Bédford Light'])
    expect(find('   ')).toEqual([])
  })

  it('caps the number of results', () => {
    expect(find('e', 2)).toHaveLength(2)
  })
})

describe('fuzzy search', () => {
  const ds = ['Electric utilities by county (EIA-861)', 'Plant points', 'plants', 'Demo vector field (synthetic)']
  const fz = (q: string) => search(ds, q, (n) => n, { fuzzy: true })

  it('tolerates typos, ranking exact matches first', () => {
    expect(fz('utilites')).toEqual(['Electric utilities by county (EIA-861)'])
    expect(fz('elcetric countey')).toEqual(['Electric utilities by county (EIA-861)'])
    expect(fz('plnts')[0]).toBe('plants')
    expect(fz('plant')).toEqual(['plants', 'Plant points']) // exact substring hits (shorter first); no typo needed
    expect(search(ds, 'utilites', (n) => n)).toEqual([]) // off unless asked
  })

  it('matches a word still being typed, but not short words loosely', () => {
    expect(fz('synthet')).toEqual(['Demo vector field (synthetic)'])
    expect(fz('xyz')).toEqual([])
  })

  it('lists everything for an empty query when asked', () => {
    expect(search(ds, '', (n) => n, { allWhenEmpty: true, limit: 2 })).toEqual(ds.slice(0, 2))
  })

  it('measures edit distance with swaps', () => {
    expect(editDistance('ab', 'ba', 2)).toBe(1)
    expect(editDistance('kitten', 'sitting', 3)).toBe(3)
    expect(editDistance('a', 'abcd', 1)).toBe(2) // gave up past the limit
  })
})

import { describe, expect, it } from 'vitest'
import { search } from './search'

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

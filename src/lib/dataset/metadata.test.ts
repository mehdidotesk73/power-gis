import { describe, expect, it } from 'vitest'
import { metadataLines, readMetadata, sameMetadata, sourceLine } from './metadata'

describe('dataset metadata', () => {
  it('reads metadata, dropping empty parts and listing what is wrong', () => {
    expect(readMetadata(undefined)).toEqual({ value: undefined, errors: [] })
    expect(readMetadata({ row: ' ', caveats: [] })).toEqual({ value: undefined, errors: [] })
    const r = readMetadata({ row: 'one county', color: 'x', columns: [{ name: 'a', unit: '$', note: 1 }, { meaning: 'no name' }], source: { publisher: 'CDC', urls: 'x' } })
    expect(r.value).toEqual({ row: 'one county', columns: [{ name: 'a', unit: '$' }], source: { publisher: 'CDC' } })
    expect(r.errors).toEqual(['metadata: unknown field "color" (fields: row, key, columns, source, caveats)', 'metadata.columns[0]: unknown field "note" (fields: name, meaning, unit)', 'metadata.columns[1] needs a "name"', 'metadata.source.urls must be a list of text'])
  })

  it('compares and writes it out', () => {
    const m = { row: 'one per county', key: 'fips', source: { publisher: 'CDC', publisherAbout: 'the federal public-health agency', title: 'PLACES', period: '2023', method: 'a model over a survey', fetched: '2026-10-31' }, caveats: ['No KY or PA'] }
    expect(sameMetadata(m, JSON.parse(JSON.stringify({ ...m, caveats: ['No KY or PA'], columns: [] })))).toBe(true)
    expect(sameMetadata(m, undefined)).toBe(false)
    expect(sameMetadata(undefined, {})).toBe(true)
    expect(sourceLine(m.source)).toBe('CDC (the federal public-health agency): PLACES, 2023')
    expect(metadataLines(m)).toEqual(['Row: one per county · key fips', 'Source: CDC (the federal public-health agency): PLACES, 2023', 'How it was made: a model over a survey', 'Fetched: 2026-10-31', 'Caveats: No KY or PA'])
  })
})

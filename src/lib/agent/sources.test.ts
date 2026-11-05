import { describe, expect, it } from 'vitest'
import { addToLedger, LEDGER_SIZE, parseScoutReport, searchLedger, type LedgerEntry } from './sources'

const report = `Found two sources for wages.
1. OECD … 2. ILOSTAT …
SOURCES: {"needs":[{"need":"average annual wage per country","sources":[{"name":"OECD AV_AN_WAGE","url":"https://data-explorer.oecd.org/wages","measures":"average annual wage per full-time worker, USD PPP, constant prices","coverage":"38 OECD countries","period":"2000-2024","access":"SDMX API, CSV","terms":"free with credit","confidence":"high"},{"name":"ILOSTAT earnings","url":"https://ilostat.ilo.org/earnings","measures":"mean monthly earnings, local currency","coverage":"~170 countries","confidence":"medium"},{"name":"no url"}],"combination":"OECD anchors; ILOSTAT fills in, calibrated per country with the price-level ratio"}]}`

describe('scout reports and the source ledger', () => {
  it('splits the SOURCES line from the prose and keeps what is readable', () => {
    const r = parseScoutReport(report)
    expect(r.text).toBe('Found two sources for wages.\n1. OECD … 2. ILOSTAT …')
    expect(r.needs).toHaveLength(1)
    expect(r.needs![0]).toMatchObject({ need: 'average annual wage per country', combination: expect.stringContaining('price-level ratio') })
    // A source without a URL is dropped; the others keep their fields.
    expect(r.needs![0].sources.map((s) => s.name)).toEqual(['OECD AV_AN_WAGE', 'ILOSTAT earnings'])
    expect(r.needs![0].sources[0]).toMatchObject({ measures: expect.stringContaining('USD PPP'), confidence: 'high' })
  })

  it('a report without (or with a broken) SOURCES line is just prose', () => {
    expect(parseScoutReport('Nothing structured.')).toEqual({ text: 'Nothing structured.' })
    expect(parseScoutReport('Text\nSOURCES: {"needs": [oops')).toEqual({ text: 'Text' })
  })

  it('keeps one entry per URL and need, the newest first, and finds them by the words of a need', () => {
    const needs = parseScoutReport(report).needs!
    let ledger: LedgerEntry[] = addToLedger([], needs, 'sesn_1', '2026-11-04')
    expect(ledger).toHaveLength(2)
    ledger = addToLedger(ledger, needs, 'sesn_2', '2026-11-05')
    expect(ledger).toHaveLength(2)
    expect(ledger[0]).toMatchObject({ runId: 'sesn_2', found: '2026-11-05' })
    expect(searchLedger(ledger, 'average wage by country').map((e) => e.name)).toEqual(['OECD AV_AN_WAGE', 'ILOSTAT earnings'])
    expect(searchLedger(ledger, 'county rents')).toEqual([])
    const many = Array.from({ length: LEDGER_SIZE + 5 }, (_, i) => ({ need: 'x', sources: [{ name: `s${i}`, url: `https://x/${i}`, measures: '', coverage: '' }] }))
    expect(addToLedger([], many, 'r', 'd')).toHaveLength(LEDGER_SIZE)
  })
})

import { describe, expect, it } from 'vitest'
import { hexToLab, labToHex, manyColors, paletteColors, PALETTES, paletteSize } from './palettes'
import { categoricalColors } from './style'

const dE = (a: string, b: string) => Math.hypot(...hexToLab(a).map((x, i) => x - hexToLab(b)[i]))

describe('palettes', () => {
  it('nests the fixed palettes, starting from Tableau', () => {
    expect(PALETTES.p12).toHaveLength(12)
    expect(PALETTES.p24.slice(0, 12)).toEqual(PALETTES.p12)
    expect(PALETTES.p60.slice(0, 24)).toEqual(PALETTES.p24)
    expect(PALETTES.p12[0]).toBe('#4e79a7')
  })

  it('keeps every fixed color distinct', () => {
    const p = PALETTES.p60
    expect(new Set(p).size).toBe(60)
    let min = Infinity
    for (let i = 0; i < p.length; i++) for (let j = 0; j < i; j++) min = Math.min(min, dE(p[i], p[j]))
    expect(min).toBeGreaterThan(15)
  })

  it('round-trips colors through CIELAB', () => {
    for (const c of ['#4e79a7', '#000000', '#ffffff', '#ff0000']) expect(labToHex(hexToLab(c))).toBe(c)
  })

  it('makes as many variations as needed, consecutive entries in different hues', () => {
    const m = manyColors(100)
    expect(m).toHaveLength(100)
    expect(m.slice(0, 12)).toEqual(PALETTES.p12)
    expect(new Set(m).size).toBeGreaterThan(95)
    for (let i = 1; i < m.length; i++) expect(dE(m[i], m[i - 1])).toBeGreaterThan(10)
  })

  it('picks a palette by name, repeating fixed ones when short', () => {
    expect(paletteColors('auto', 13)).toEqual(PALETTES.p24.slice(0, 13))
    expect(paletteColors('auto', 61)).toEqual(manyColors(61))
    expect(paletteColors('p12', 14).slice(12)).toEqual(PALETTES.p12.slice(0, 2))
    expect(paletteSize('p12', 14)).toBe(12)
    expect(paletteSize('auto', 300)).toBe(300)
  })

  it('colors every category of a field, honoring explicit colors', () => {
    const feats = ['TX', 'CA', 'NY', 'CA', null].map((s, i) => ({ type: 'Feature' as const, id: i, geometry: { type: 'Point' as const, coordinates: [0, 0] }, properties: { s } }))
    const c = categoricalColors({ kind: 'categorical', field: 's', colors: { NY: '#000000' } }, feats)
    expect(c.map((x) => x.value)).toEqual(['CA', 'NY', 'TX']) // sorted, no cap
    expect(c.find((x) => x.value === 'NY')!.color).toBe('#000000')
    expect(c.find((x) => x.value === 'CA')!.color).toBe(PALETTES.p12[0])
    const states = Array.from({ length: 52 }, (_, i) => ({ ...feats[0], id: i, properties: { s: `S${i}` } }))
    expect(new Set(categoricalColors({ kind: 'categorical', field: 's' }, states).map((x) => x.color)).size).toBe(52)
  })
})

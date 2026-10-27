import { describe, expect, it } from 'vitest'
import { colorExpression, colorLegend, colormapDomain, opacityExpression, patternGroups, stopValues, vectorOf } from './style'
import { patternRaster, arrowSdf } from './rasters'
import type { LayerFeature } from './schema'

const feats = [1, 5, 9].map(
  (n) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { n, kind: n > 4 ? 'big' : 'small' } }) as LayerFeature,
)

describe('style expressions', () => {
  it('builds a colormap ramp over the data range with a null fallback', () => {
    const e = colorExpression({ kind: 'colormap', field: 'n', colormap: 'blues', nullColor: '#000' }, feats) as unknown[]
    expect(e[0]).toBe('case')
    const ramp = e[2] as unknown[]
    expect(ramp[0]).toBe('interpolate')
    expect(ramp[3]).toBe(1) // first stop at min
    expect(ramp[ramp.length - 2]).toBe(9) // last stop at max
    expect(e[3]).toBe('#000')
  })

  it('makes strictly ascending stops even for a flat domain', () => {
    const s = stopValues([3, 3], 4)
    expect(s.every((v, i) => i === 0 || v > s[i - 1])).toBe(true)
    const log = stopValues([1, 1000], 4, 'log')
    expect(log.map((v) => Math.round(v))).toEqual([1, 10, 100, 1000])
  })

  it('starts a log scale at the smallest positive value, and honors a fixed domain', () => {
    const withZero = [0, 2, 2000].map((n) => ({ ...feats[0], properties: { n } }) as LayerFeature)
    expect(colormapDomain({ kind: 'colormap', field: 'n', colormap: 'blues', scale: 'log' }, withZero)).toEqual([2, 2000])
    expect(colormapDomain({ kind: 'colormap', field: 'n', colormap: 'blues' }, withZero)).toEqual([0, 2000])
    expect(colormapDomain({ kind: 'colormap', field: 'n', colormap: 'rdBu', domain: [-5, 5] }, withZero)).toEqual([-5, 5])
    expect(colorLegend({ kind: 'colormap', field: 'n', colormap: 'blues', domain: [1, 100] }, withZero, 'N')).toMatchObject({ min: 1, max: 100, clippedLow: true, clippedHigh: true })
    expect(colorLegend({ kind: 'colormap', field: 'n', colormap: 'blues' }, withZero, 'N')).not.toHaveProperty('clippedHigh')
  })

  it('assigns categorical colors, honoring explicit ones', () => {
    const e = colorExpression({ kind: 'categorical', field: 'kind', colors: { small: '#f00' } }, feats) as unknown[]
    expect(e[0]).toBe('match')
    expect(e).toContain('#f00')
    expect(e).toContain('big')
  })

  it('passes constants through', () => {
    expect(colorExpression({ kind: 'constant', color: '#123456' }, feats)).toBe('#123456')
    expect(opacityExpression({ kind: 'constant', value: 0.4 }, feats)).toBe(0.4)
  })

  it('groups pattern values into one layer per pattern', () => {
    const g = patternGroups({ kind: 'field', field: 'kind', patterns: { big: 'hatch', small: 'hatch', other: 'dots' } })
    expect(g.map((x) => x.pattern)).toEqual(['hatch', 'dots'])
    expect(g[0].filter).toEqual(['in', ['to-string', ['get', 'kind']], ['literal', ['big', 'small']]])
    expect(patternGroups({ kind: 'none' })).toEqual([])
  })
})

describe('vectors', () => {
  it('converts u/v to compass direction', () => {
    expect(vectorOf({ u: 0, v: 2 }, { kind: 'uv', u: 'u', v: 'v' })).toEqual({ magnitude: 2, direction: 0 })
    expect(vectorOf({ u: 3, v: 0 }, { kind: 'uv', u: 'u', v: 'v' })?.direction).toBeCloseTo(90)
    expect(vectorOf({ u: 0, v: -1 }, { kind: 'uv', u: 'u', v: 'v' })?.direction).toBeCloseTo(180)
    expect(vectorOf({ u: -1, v: 0 }, { kind: 'uv', u: 'u', v: 'v' })?.direction).toBeCloseTo(270)
    expect(vectorOf({ m: 4, d: -90 }, { kind: 'polar', magnitude: 'm', direction: 'd' })).toEqual({ magnitude: 4, direction: 270 })
    expect(vectorOf({ u: null, v: 1 }, { kind: 'uv', u: 'u', v: 'v' })).toBeNull()
  })
})

describe('rasters', () => {
  it('draws pattern tiles of the requested color', () => {
    const r = patternRaster('hatch', '#ff0000', 16, 2)
    expect(r.data.length).toBe(16 * 16 * 4)
    const on = [...Array(256).keys()].filter((i) => r.data[i * 4 + 3] === 255)
    expect(on.length).toBeGreaterThan(0)
    expect(on.length).toBeLessThan(256)
    expect(r.data[on[0] * 4]).toBe(255)
  })

  it('draws an arrow SDF that is solid inside and empty outside', () => {
    const r = arrowSdf(48, 8)
    const alpha = (x: number, y: number) => r.data[(y * 48 + x) * 4 + 3]
    expect(alpha(24, 30)).toBeGreaterThan(191) // shaft
    expect(alpha(2, 2)).toBe(0) // corner
  })
})

describe('focusBox', () => {
  it('ignores far-flung outliers once there are many features', async () => {
    const { focusBox } = await import('./geometry')
    const pts = Array.from({ length: 200 }, (_, i) => ({ type: 'Point' as const, coordinates: [-100 + (i % 20), 30 + (i % 10)] }))
    pts.push({ type: 'Point', coordinates: [179, 52] }) // an Aleutian island
    const [minX, , maxX] = focusBox(pts)!
    expect(minX).toBeGreaterThanOrEqual(-100)
    expect(maxX).toBeLessThan(-70)
    expect(focusBox(pts.slice(0, 3))).toEqual([-100, 30, -98, 32]) // few features: exact bbox
  })
})

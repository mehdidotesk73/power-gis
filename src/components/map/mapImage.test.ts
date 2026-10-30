import { describe, expect, it } from 'vitest'
import { fmt, gradientStops } from './mapImage'

describe('the legend ramp in the map picture', () => {
  it('reads the stops of the CSS gradient the legend shows', () => {
    expect(gradientStops('linear-gradient(to right, #440154 0%, #21918c 50%, #fde725 100%)')).toEqual([
      { color: '#440154', at: 0 },
      { color: '#21918c', at: 0.5 },
      { color: '#fde725', at: 1 },
    ])
    expect(gradientStops('linear-gradient(90deg, rgb(0, 0, 0), #fff)')).toEqual([
      { color: 'rgb(0, 0, 0)', at: 0 },
      { color: '#fff', at: 1 },
    ])
  })

  it('writes legend numbers compactly', () => {
    expect([fmt(25400), fmt(110000), fmt(1250), fmt(0.374), fmt(0.004)]).toEqual(['25.4K', '110K', '1,250', '0.374', '4.0e-3'])
  })
})

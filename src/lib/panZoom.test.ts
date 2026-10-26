import { describe, expect, it } from 'vitest'
import { clampPan, fitView, MAX_ZOOM, MIN_ZOOM, zoomAt } from './panZoom'

describe('pan / zoom', () => {
  it('zooms about a point, keeping that point fixed', () => {
    const v = zoomAt({ x: 10, y: 20, k: 1 }, 110, 70, 2)
    expect(v.k).toBe(2)
    // canvas point under (110, 70) was (100, 50); it must still be there
    expect(v.x + 100 * v.k).toBe(110)
    expect(v.y + 50 * v.k).toBe(70)
  })

  it('clamps zoom', () => {
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 0, 0, 100).k).toBe(MAX_ZOOM)
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 0, 0, 0.001).k).toBe(MIN_ZOOM)
  })

  it('fits and centers without enlarging', () => {
    expect(fitView(200, 100, 400, 300)).toEqual({ k: 1, x: 100, y: 100 })
    const v = fitView(800, 200, 400, 300)
    expect(v.k).toBeCloseTo(384 / 800)
    expect(v.x).toBeCloseTo((400 - 800 * v.k) / 2)
  })

  it('keeps part of the canvas on screen', () => {
    const v = clampPan({ x: -5000, y: 9000, k: 1 }, 400, 300, 300, 200)
    expect(v.x).toBe(48 - 400)
    expect(v.y).toBe(200 - 48)
  })
})

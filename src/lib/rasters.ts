// Small RGBA rasters for map images — fill patterns and the arrow glyph.
// Pure pixel math (no canvas) so they're deterministic and testable; MapLibre
// accepts {width, height, data} directly in map.addImage.

import type { PatternKind } from './style'

export interface Raster {
  width: number
  height: number
  data: Uint8ClampedArray
}

function parseColor(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6)
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * A seamlessly tiling pattern tile. `size` is in device pixels; register it
 * with pixelRatio 2 so lines stay crisp on phones.
 */
export function patternRaster(kind: PatternKind, color: string, size = 16, thickness = 2): Raster {
  const [r, g, b] = parseColor(color)
  const data = new Uint8ClampedArray(size * size * 4)
  const half = size / 2
  const on = (x: number, y: number): boolean => {
    switch (kind) {
      case 'hatch':
        return (x + y) % half < thickness
      case 'backhatch':
        return (((x - y) % half) + half) % half < thickness
      case 'cross':
        return (x + y) % half < thickness || (((x - y) % half) + half) % half < thickness
      case 'horizontal':
        return y % half < thickness
      case 'vertical':
        return x % half < thickness
      case 'dots': {
        const cx = (x % half) - half / 2 + 0.5
        const cy = (y % half) - half / 2 + 0.5
        return cx * cx + cy * cy <= thickness * thickness
      }
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!on(x, y)) continue
      const i = (y * size + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return { width: size, height: size, data }
}

/**
 * An upward-pointing arrow as a signed-distance-field image, so MapLibre can
 * recolor it per feature (icon-color) and scale it without blurring.
 * Uses the TinySDF encoding: alpha = 255·(1 − (d/radius + 0.25)), edge ≈ 191.
 */
export function arrowSdf(size = 48, radius = 8): Raster {
  const pad = radius
  const inner = size - 2 * pad
  const cx = size / 2
  const headH = inner * 0.45
  const headW = inner * 0.62
  const shaftW = inner * 0.2
  const top = pad
  const bottom = size - pad
  const inside = (x: number, y: number): boolean => {
    if (y < top || y > bottom) return false
    if (y < top + headH) {
      const t = (y - top) / headH
      return Math.abs(x - cx) <= (headW / 2) * t
    }
    return Math.abs(x - cx) <= shaftW / 2
  }

  const mask = new Uint8Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) mask[y * size + x] = inside(x + 0.5, y + 0.5) ? 1 : 0

  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const me = mask[y * size + x]
      let best = radius * radius
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= size) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= size) continue
          if (mask[yy * size + xx] !== me) {
            const d2 = dx * dx + dy * dy
            if (d2 < best) best = d2
          }
        }
      }
      const d = (me ? -1 : 1) * (Math.sqrt(best) - 0.5)
      const i = (y * size + x) * 4
      data[i] = data[i + 1] = data[i + 2] = 255
      data[i + 3] = Math.round(255 * (1 - (d / radius + 0.25)))
    }
  }
  return { width: size, height: size, data }
}

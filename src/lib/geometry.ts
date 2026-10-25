import type { Geometry, Position } from 'geojson'

function ringArea(ring: Position[]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return a / 2
}

function ringCentroid(ring: Position[]): [number, number, number] {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    a += f
    cx += (ring[j][0] + ring[i][0]) * f
    cy += (ring[j][1] + ring[i][1]) * f
  }
  a /= 2
  if (Math.abs(a) < 1e-12) return [ring[0][0], ring[0][1], 0]
  return [cx / (6 * a), cy / (6 * a), Math.abs(a)]
}

/**
 * A representative point: the area centroid of the largest polygon for
 * regions, the middle vertex for lines, the point itself for points.
 */
export function anchorPoint(g: Geometry | null): [number, number] | null {
  if (!g) return null
  switch (g.type) {
    case 'Point':
      return [g.coordinates[0], g.coordinates[1]]
    case 'MultiPoint':
      return g.coordinates.length ? [g.coordinates[0][0], g.coordinates[0][1]] : null
    case 'LineString': {
      const c = g.coordinates[Math.floor(g.coordinates.length / 2)]
      return c ? [c[0], c[1]] : null
    }
    case 'MultiLineString':
      return anchorPoint({ type: 'LineString', coordinates: g.coordinates.reduce((a, b) => (b.length > a.length ? b : a), []) })
    case 'Polygon': {
      const [x, y] = ringCentroid(g.coordinates[0])
      return [x, y]
    }
    case 'MultiPolygon': {
      let best: [number, number, number] | null = null
      for (const poly of g.coordinates) {
        const c = ringCentroid(poly[0])
        if (!best || c[2] > best[2]) best = c
      }
      return best ? [best[0], best[1]] : null
    }
    default:
      return null
  }
}

export function polygonArea(g: Geometry): number {
  if (g.type === 'Polygon') return Math.abs(ringArea(g.coordinates[0]))
  if (g.type === 'MultiPolygon') return g.coordinates.reduce((s, p) => s + Math.abs(ringArea(p[0])), 0)
  return 0
}

export type BBox = [number, number, number, number]

/** Bounding box of a set of geometries; null if empty. */
export function bboxOf(geoms: (Geometry | null)[]): BBox | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as number[]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    } else (c as unknown[]).forEach(visit)
  }
  for (const g of geoms) if (g && 'coordinates' in g) visit(g.coordinates)
  return minX === Infinity ? null : [minX, minY, maxX, maxY]
}

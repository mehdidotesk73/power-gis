import type { Map as MlMap } from 'maplibre-gl'
import { arrowSdf, patternRaster } from '../../lib/rasters'
import { patternImageId, type PatternKind } from '../../lib/style'

export const ARROW_IMAGE = 'arrow-sdf'

export function ensurePatternImage(map: MlMap, kind: PatternKind, color: string): string {
  const id = patternImageId(kind, color)
  if (!map.hasImage(id)) map.addImage(id, patternRaster(kind, color, 16, 2), { pixelRatio: 2 })
  return id
}

export function ensureArrowImage(map: MlMap): string {
  if (!map.hasImage(ARROW_IMAGE)) map.addImage(ARROW_IMAGE, arrowSdf(48, 8), { pixelRatio: 2, sdf: true })
  return ARROW_IMAGE
}

const urlCache = new Map<string, string>()

/** A pattern tile as a data URL, for legend swatches. */
export function patternDataUrl(kind: PatternKind, color: string): string {
  const key = patternImageId(kind, color)
  const hit = urlCache.get(key)
  if (hit) return hit
  const r = patternRaster(kind, color, 16, 2)
  const canvas = document.createElement('canvas')
  canvas.width = r.width
  canvas.height = r.height
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0)
  const url = canvas.toDataURL()
  urlCache.set(key, url)
  return url
}

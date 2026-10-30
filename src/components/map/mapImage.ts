// The map as a picture: what the map shows right now, with its legend and the
// basemap's attribution drawn in (the legend and attribution are page elements,
// not part of the map's canvas). The canvas is read right after a fresh render
// (MapLibre doesn't keep its drawing buffer). The clipboard copy uses it now; the
// reviewer and the assistant will use it to look at a visualization.
import type { Map as MlMap } from 'maplibre-gl'
import type { LegendEntry } from '../../lib/style'
import { wrapLines } from '../../lib/textFit'

/** The map's current view, with `legend`, as a PNG. */
export function mapPng(map: MlMap, legend: LegendEntry[]): Promise<Blob> {
  return new Promise((resolve, reject) => {
    map.once('render', () => {
      try {
        const src = map.getCanvas()
        const out = document.createElement('canvas')
        out.width = src.width
        out.height = src.height
        const ctx = out.getContext('2d')
        if (!ctx) throw new Error('this browser can’t draw images')
        ctx.drawImage(src, 0, 0)
        // Page pixels from here on, so text keeps its size whatever the screen.
        const scale = src.width / (src.clientWidth || src.width)
        ctx.scale(scale, scale)
        const style = getComputedStyle(map.getContainer())
        const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
        const font = style.fontFamily || 'system-ui, sans-serif'
        drawLegend(ctx, legend, { token, font })
        drawAttribution(ctx, attributionOf(map), src.clientWidth || src.width, src.clientHeight || src.height, { token, font })
        out.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be made'))), 'image/png')
      } catch (e) {
        reject(e)
      }
    })
    map.triggerRepaint()
  })
}

interface Look {
  token: (name: string, fallback: string) => string
  font: string
}

/** The color stops of a CSS linear-gradient (the legend's ramp). */
export function gradientStops(css: string): { color: string; at: number }[] {
  const stops = [...css.matchAll(/(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))\s*([\d.]+)%/gi)].map((m) => ({ color: m[1], at: Number(m[2]) / 100 }))
  if (stops.length) return stops
  const colors = [...css.matchAll(/(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi)].map((m) => m[1])
  return colors.map((color, i) => ({ color, at: colors.length > 1 ? i / (colors.length - 1) : 0 }))
}

const MAX_SWATCHES = 12
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 })
/** A legend number: 25.4K, 1.2M, 0.37, 1,250. */
export const fmt = (n: number) => (Math.abs(n) >= 1e4 ? compact.format(n) : Math.abs(n) < 0.01 && n !== 0 ? n.toExponential(1) : Number(n.toPrecision(3)).toLocaleString('en'))

function drawLegend(ctx: CanvasRenderingContext2D, entries: LegendEntry[], look: Look) {
  if (!entries.length) return
  const pad = 8
  const w = 220
  const x = 10
  const lines: { h: number; draw: (y: number) => void }[] = []
  for (const e of entries) {
    // The title on up to two lines.
    ctx.font = `600 12px ${look.font}`
    for (const t of wrapLines(e.title, w - 2 * pad, 2, (s) => ctx.measureText(s).width))
      lines.push({
        h: 16,
        draw: (y) => {
          ctx.font = `600 12px ${look.font}`
          ctx.fillStyle = look.token('--text', '#e6e8ee')
          ctx.fillText(t, x + pad, y + 12)
        },
      })
    if (e.kind === 'ramp') {
      lines.push({
        h: 30,
        draw: (y) => {
          const g = ctx.createLinearGradient(x + pad, 0, x + w - pad, 0)
          for (const s of gradientStops(e.gradient)) g.addColorStop(Math.min(1, Math.max(0, s.at)), s.color)
          ctx.fillStyle = g
          ctx.fillRect(x + pad, y + 2, w - 2 * pad, 10)
          ctx.font = `11px ${look.font}`
          ctx.fillStyle = look.token('--text-muted', '#9aa3b2')
          ctx.textAlign = 'left'
          ctx.fillText(`${e.clippedLow ? '≤ ' : ''}${fmt(e.min)}`, x + pad, y + 25)
          ctx.textAlign = 'right'
          ctx.fillText(`${e.clippedHigh ? '≥ ' : ''}${fmt(e.max)}${e.scale === 'log' ? ' (log)' : ''}`, x + w - pad, y + 25)
          ctx.textAlign = 'left'
        },
      })
    } else {
      const shown = e.items.slice(0, MAX_SWATCHES)
      for (const item of shown)
        lines.push({
          h: 16,
          draw: (y) => {
            ctx.fillStyle = item.color
            ctx.fillRect(x + pad, y + 3, 11, 11)
            ctx.font = `11px ${look.font}`
            ctx.fillStyle = look.token('--text', '#e6e8ee')
            ctx.fillText(clip(ctx, item.label, w - 2 * pad - 17), x + pad + 17, y + 12)
          },
        })
      if (e.items.length > shown.length)
        lines.push({
          h: 16,
          draw: (y) => {
            ctx.font = `11px ${look.font}`
            ctx.fillStyle = look.token('--text-muted', '#9aa3b2')
            ctx.fillText(`+ ${e.items.length - shown.length} more`, x + pad, y + 12)
          },
        })
    }
  }
  const h = lines.reduce((s, l) => s + l.h, 0) + 2 * pad
  ctx.globalAlpha = 0.9
  ctx.fillStyle = look.token('--bg-elev', '#161a22')
  ctx.beginPath()
  ctx.roundRect(x, 10, w, h, 8)
  ctx.fill()
  ctx.globalAlpha = 1
  let y = 10 + pad
  for (const l of lines) {
    l.draw(y)
    y += l.h
  }
}

/** The basemap's attribution, as plain text (the sources' HTML stripped). */
function attributionOf(map: MlMap): string {
  const sources = Object.values(map.getStyle()?.sources ?? {}) as { attribution?: string }[]
  const texts = sources.flatMap((s) => (s.attribution ? [s.attribution.replace(/<[^>]*>/g, '').replace(/&copy;/g, '©').replace(/\s+/g, ' ').trim()] : []))
  return [...new Set(texts)].join(' · ')
}

function drawAttribution(ctx: CanvasRenderingContext2D, text: string, w: number, h: number, look: Look) {
  if (!text) return
  ctx.font = `10px ${look.font}`
  const tw = Math.min(ctx.measureText(text).width, w - 20)
  ctx.globalAlpha = 0.75
  ctx.fillStyle = look.token('--bg', '#0d1016')
  ctx.fillRect(w - tw - 12, h - 16, tw + 12, 16)
  ctx.globalAlpha = 1
  ctx.fillStyle = look.token('--text-muted', '#9aa3b2')
  ctx.textAlign = 'right'
  ctx.fillText(clip(ctx, text, w - 20), w - 6, h - 5)
  ctx.textAlign = 'left'
}

function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1)
  return `${t}…`
}

// The graph as a picture: what the graph's window shows right now (its pan
// and zoom), drawn on a canvas from the layout — not a screenshot of the DOM,
// which browsers (iOS Safari above all) don't offer. Colors come from the
// page's tokens, so the picture matches the app.
import { edgePath, NODE_H, NODE_W, type Dag, type DagLayout, type DagNode } from '../../lib/workspace/dag'
import { ellipsize, wrapLines } from '../../lib/textFit'
import { saveFile } from '../../client/saveFile'

export interface GraphView {
  x: number
  y: number
  k: number
}

const KIND: Record<DagNode['kind'], { color: string; tag: string }> = {
  dataset: { color: '--kind-dataset', tag: 'DATASET' },
  transform: { color: '--kind-transform', tag: 'TRANSFORM' },
  viz: { color: '--kind-viz', tag: 'VIZ' },
}

/** Draws the visible part of the graph (`width` × `height` CSS pixels) into a PNG. */
export function graphPng(el: HTMLElement, dag: Dag, layout: DagLayout, view: GraphView, width: number, height: number): Promise<Blob> {
  const css = getComputedStyle(el)
  const token = (name: string) => css.getPropertyValue(name).trim() || '#888'
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const font = css.fontFamily || 'system-ui, sans-serif'
  const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 1))

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('this browser can’t draw images'))
  ctx.scale(scale, scale)
  ctx.fillStyle = token('--bg')
  ctx.fillRect(0, 0, width, height)
  ctx.translate(view.x, view.y)
  ctx.scale(view.k, view.k)

  // Edges, then arrowheads where they meet their node.
  const edge = token('--text-muted')
  ctx.strokeStyle = edge
  ctx.fillStyle = edge
  ctx.globalAlpha = 0.7
  ctx.lineWidth = 1.5
  const v = layout.direction === 'vertical'
  for (const e of dag.edges) {
    const d = edgePath(layout, e)
    const to = layout.at.get(e.to)
    if (!d || !to) continue
    ctx.stroke(new Path2D(d))
    const tip = v ? { x: to.x + NODE_W / 2, y: to.y } : { x: to.x, y: to.y + NODE_H / 2 }
    ctx.beginPath()
    if (v) ctx.moveTo(tip.x, tip.y), ctx.lineTo(tip.x - 4.5, tip.y - 7), ctx.lineTo(tip.x + 4.5, tip.y - 7)
    else ctx.moveTo(tip.x, tip.y), ctx.lineTo(tip.x - 7, tip.y - 4.5), ctx.lineTo(tip.x - 7, tip.y + 4.5)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  for (const n of dag.nodes) {
    const at = layout.at.get(n.key)
    if (at) drawNode(ctx, n, at.x, at.y, { token, rem, font })
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be made'))), 'image/png'))
}

function drawNode(ctx: CanvasRenderingContext2D, n: DagNode, x: number, y: number, s: { token: (n: string) => string; rem: number; font: string }) {
  const problem = n.problem === 'missing' || n.problem === 'waits'
  const color = problem ? s.token('--danger') : s.token(KIND[n.kind].color)
  const box = new Path2D()
  box.roundRect(x + 0.5, y + 0.5, NODE_W - 1, NODE_H - 1, 9)
  ctx.globalAlpha = n.kind === 'viz' && n.muted ? 0.6 : 1
  ctx.fillStyle = s.token('--bg')
  ctx.fill(box)
  ctx.save()
  ctx.globalAlpha *= problem ? 0.1 : 0.14
  ctx.fillStyle = color
  ctx.fill(box)
  ctx.restore()
  ctx.strokeStyle = color
  ctx.lineWidth = n.problem === 'missing' ? 2 : 1
  ctx.setLineDash((n.kind === 'transform' && n.state === 'not-run') || n.problem === 'waits' ? [4, 3] : [])
  ctx.stroke(box)
  ctx.setLineDash([])

  // Three lines, centered as the node shows them: the kind, the name (two lines at most), the detail.
  const pad = 6
  const inner = NODE_W - 2 * pad
  const tagSize = 0.56 * s.rem
  const labelSize = 0.7 * s.rem
  const detailSize = 0.6 * s.rem
  ctx.font = `600 ${labelSize}px ${s.font}`
  const label = wrapLines(n.label, inner, 2, (t) => ctx.measureText(t).width)
  const heights = [tagSize * 1.25, label.length * labelSize * 1.15, detailSize * 1.25]
  let top = y + (NODE_H - heights.reduce((a, b) => a + b, 0) - 2) / 2
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const cx = x + NODE_W / 2

  ctx.font = `700 ${tagSize}px ${s.font}`
  ctx.fillStyle = s.token('--text-muted')
  const tag = KIND[n.kind].tag
  if (n.kind === 'dataset') {
    // The store dot before DATASET: violet in the cloud, gray on this device; an amber ring when pending.
    const w = ctx.measureText(tag).width
    const dot = { x: cx - w / 2 - 5, y: top + tagSize * 0.55 }
    ctx.beginPath()
    ctx.arc(dot.x, dot.y, 3.2, 0, Math.PI * 2)
    ctx.fillStyle = n.store === 'remote' ? s.token('--kind-dataset') : s.token('--text-muted')
    ctx.fill()
    if (n.pending) {
      ctx.strokeStyle = s.token('--warn')
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    ctx.fillStyle = s.token('--text-muted')
    ctx.fillText(tag, cx + 4, top)
  } else ctx.fillText(tag, cx, top)
  top += heights[0] + 1

  ctx.font = `600 ${labelSize}px ${s.font}`
  ctx.fillStyle = s.token('--text')
  for (const line of label) {
    ctx.fillText(line, cx, top)
    top += labelSize * 1.15
  }
  top += 1

  ctx.font = `${n.state === 'stale' ? '650 ' : ''}${detailSize}px ${s.font}`
  ctx.fillStyle = problem ? s.token('--danger') : n.state === 'stale' ? s.token('--text') : s.token('--text-muted')
  ctx.fillText(ellipsize(n.detail, inner, (t) => ctx.measureText(t).width), cx, top)

  // Corner badge: ⚠ missing here, ↻ needs re-run.
  const badge = n.problem === 'missing' ? { bg: '--danger', fg: '--on-accent', mark: '⚠' } : n.kind === 'transform' && n.state === 'stale' && !n.problem ? { bg: '--warn', fg: '--on-amber', mark: '↻' } : null
  if (badge) {
    const r = 0.525 * s.rem
    ctx.beginPath()
    ctx.arc(x + NODE_W - 2 - r, y + 2 + r, r, 0, Math.PI * 2)
    ctx.fillStyle = s.token(badge.bg)
    ctx.fill()
    ctx.font = `800 ${0.68 * s.rem}px ${s.font}`
    ctx.fillStyle = s.token(badge.fg)
    ctx.textBaseline = 'middle'
    ctx.fillText(badge.mark, x + NODE_W - 2 - r, y + 2 + r + 0.5)
  }
  ctx.globalAlpha = 1
}

/**
 * Puts the picture on the clipboard. The clipboard is asked at once, inside
 * the tap, with the picture still being drawn (iOS Safari refuses a write that
 * starts after an await). Where the clipboard can't take images, it's
 * downloaded instead. Resolves to what happened.
 */
export async function copyPng(make: () => Promise<Blob>, fileName: string): Promise<'copied' | 'downloaded'> {
  const blob = make()
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('no image clipboard')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return 'copied'
  } catch {
    await saveFile(await blob, fileName)
    return 'downloaded'
  }
}

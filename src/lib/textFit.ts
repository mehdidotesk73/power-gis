// Fitting text into a box when drawing it ourselves (canvas has no line
// clamping or ellipsis). The measure function is the canvas's measureText
// width, so this stays testable without a canvas.

export type Measure = (text: string) => number

/** Shortens `text` with an ellipsis until it fits `maxWidth`. */
export function ellipsize(text: string, maxWidth: number, measure: Measure): string {
  if (measure(text) <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(`${text.slice(0, mid).trimEnd()}…`) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo).trimEnd()}…`
}

/**
 * Wraps `text` at spaces into at most `maxLines` lines of `maxWidth`; the last
 * line ends in an ellipsis when text is left over. A word wider than a line is
 * cut with an ellipsis.
 */
export function wrapLines(text: string, maxWidth: number, maxLines: number, measure: Measure): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  let i = 0
  for (; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]
    if (measure(next) <= maxWidth) {
      line = next
      continue
    }
    if (line) lines.push(line)
    if (lines.length === maxLines) break
    line = words[i]
  }
  if (lines.length < maxLines && line) lines.push(line)
  const rest = i < words.length
  return lines.map((l, n) => (n === lines.length - 1 && rest ? ellipsize(`${l} ${words.slice(i).join(' ')}`, maxWidth, measure) : ellipsize(l, maxWidth, measure)))
}

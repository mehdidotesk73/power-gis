// Ranked search over a list of named items. Every query word must match the
// item's text; names that start with the query rank first. With `fuzzy`, a
// word also matches a word of the text it's close to (a typo or two —
// "elastic" search), ranked after exact matches. Cheap enough for lists of
// thousands; the fuzzy pass only runs for words that didn't match exactly.

export interface SearchHit<T> {
  item: T
  score: number
}

export interface SearchOptions {
  limit?: number
  /** Tolerate typos (edit distance 1 for words of 4+ letters, 2 for 8+). */
  fuzzy?: boolean
  /** An empty query lists the first `limit` items instead of nothing. */
  allWhenEmpty?: boolean
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

/** Edit distance (insert / delete / substitute / swap neighbours), giving up past `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev2 = new Array(b.length + 1).fill(0)
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1)
      cur.push(d)
      best = Math.min(best, d)
    }
    if (best > max) return max + 1
    prev2.splice(0, prev2.length, ...prev)
    prev = cur
  }
  return prev[b.length]
}

const allowed = (w: string) => (w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0)

/** 0 = exact (substring), 1 = close to a word of the text (or its start), Infinity = no match. */
function wordMatch(word: string, text: string, tokens: string[], fuzzy: boolean): number {
  if (text.includes(word)) return 0
  const max = fuzzy ? allowed(word) : 0
  if (!max) return Infinity
  for (const t of tokens) {
    if (editDistance(word, t, max) <= max) return 1
    // A word still being typed: compare with the start of a longer word.
    if (t.length > word.length && editDistance(word, t.slice(0, word.length), max) <= max) return 1
  }
  return Infinity
}

export function search<T>(items: T[], query: string, text: (t: T) => string, opts: number | SearchOptions = {}): T[] {
  const { limit = 12, fuzzy = false, allWhenEmpty = false } = typeof opts === 'number' ? { limit: opts } : opts
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (!words.length) return allWhenEmpty ? items.slice(0, limit) : []
  const q = words.join(' ')
  const hits: SearchHit<T>[] = []
  for (const item of items) {
    const t = norm(text(item))
    const tokens = t.split(/[^a-z0-9]+/).filter(Boolean)
    let typos = 0
    for (const w of words) {
      const m = wordMatch(w, t, tokens, fuzzy)
      if (m === Infinity) {
        typos = Infinity
        break
      }
      typos += m
    }
    if (typos === Infinity) continue
    // Lower is better: exact before fuzzy; whole-query prefix, then word-start match, then anywhere; shorter names win ties.
    const score = typos * 10_000 + (t.startsWith(q) ? 0 : t.includes(' ' + words[0]) ? 1 : 2) * 1000 + t.length
    hits.push({ item, score })
  }
  return hits
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((h) => h.item)
}

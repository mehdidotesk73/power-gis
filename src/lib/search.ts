// Ranked substring search over a list of named items. Every query word must
// appear in the item's text; names that start with the query rank first.

export interface SearchHit<T> {
  item: T
  score: number
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

export function search<T>(items: T[], query: string, text: (t: T) => string, limit = 12): T[] {
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const q = words.join(' ')
  const hits: SearchHit<T>[] = []
  for (const item of items) {
    const t = norm(text(item))
    if (!words.every((w) => t.includes(w))) continue
    // Lower is better: whole-query prefix, then word-start match, then anywhere; shorter names win ties.
    const score = (t.startsWith(q) ? 0 : t.includes(' ' + words[0]) ? 1 : 2) * 1000 + t.length
    hits.push({ item, score })
  }
  return hits
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((h) => h.item)
}

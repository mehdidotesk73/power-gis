import Papa from 'papaparse'

/** CSV text → records keyed by header, values as strings (empty cells as ''). */
export function parseCsv(text: string): Record<string, string>[] {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, dynamicTyping: false })
  return parsed.data
}

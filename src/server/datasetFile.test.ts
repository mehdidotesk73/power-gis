import { describe, expect, it } from 'vitest'
import { decodeDatasetFile, encodeDatasetFile } from './datasetFile'
import type { ColumnInfo } from '../lib/dataset/columns'

describe('dataset files (cloud storage)', () => {
  it('writes rows to a compressed file and reads the same rows back, typed by the columns', async () => {
    const columns: ColumnInfo[] = [
      { name: 'fips', type: 'string' },
      { name: 'n', type: 'int' },
      { name: 'x', type: 'double' },
      { name: 'ok', type: 'boolean' },
      { name: 'at', type: 'datetime' },
      { name: 'wind', type: 'vector' },
      { name: 'geometry', type: 'point' },
    ]
    const rows = [
      { fips: '01001', n: 3, x: 1.5, ok: true, at: '2026-01-02T03:04:05.000Z', wind: { u: 1, v: -2 }, geometry: { type: 'Point', coordinates: [-86.6, 32.5] } },
      { fips: '01003', n: null, x: null, ok: false, at: null, wind: null, geometry: null },
    ]
    const bytes = await encodeDatasetFile(columns, rows)
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]) // gzip
    expect(await decodeDatasetFile(bytes, columns)).toEqual(rows)
  })
  it('stays small for a large table', async () => {
    const columns: ColumnInfo[] = [{ name: 'fips', type: 'string' }, { name: 'v', type: 'double' }]
    const rows = Array.from({ length: 20000 }, (_, i) => ({ fips: String(i).padStart(5, '0'), v: i % 7 }))
    const bytes = await encodeDatasetFile(columns, rows)
    expect(bytes.byteLength).toBeLessThan(120_000)
    expect((await decodeDatasetFile(bytes, columns)).length).toBe(20000)
  })
})

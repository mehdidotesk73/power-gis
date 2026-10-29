// A dataset's rows as one file, the way cloud storage keeps them: an Arrow IPC
// stream (columnar, what DuckDB loads natively), gzip-compressed. Each column
// keeps its name; numbers are doubles, booleans booleans, and everything else
// text (datetimes as ISO, vectors and geometries as JSON). The dataset's
// registry row carries the column types that read it back. Needs no SQL
// engine: opening a workspace downloads and reads files before DuckDB loads.
import { Bool, Float64, Table, Utf8, tableFromIPC, tableToIPC, vectorFromArray } from 'apache-arrow'
import type { DataRecord } from '../lib/data/connectors'
import { isGeometryColumn, type ColumnInfo } from '../lib/dataset/columns'


function cell(v: unknown, c: ColumnInfo): number | boolean | string | null {
  if (v === null || v === undefined || v === '') return null
  switch (c.type) {
    case 'int':
    case 'double': {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    case 'boolean':
      return v === true || /^(true|1)$/i.test(String(v))
    case 'datetime': {
      const d = new Date(String(v))
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
}

function value(v: unknown, c: ColumnInfo): unknown {
  if (v === null || v === undefined) return null
  if (c.type === 'int') return Math.round(Number(v))
  if (c.type === 'vector' || (isGeometryColumn(c.type) && typeof v === 'string' && /^\s*[{[]/.test(v))) {
    try {
      return JSON.parse(String(v))
    } catch {
      return v
    }
  }
  return v
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer())
}

/** The rows as the file's bytes. */
export async function encodeDatasetFile(columns: ColumnInfo[], rows: DataRecord[]): Promise<Uint8Array> {
  const vectors = Object.fromEntries(
    columns.map((c) => {
      const type = c.type === 'int' || c.type === 'double' ? new Float64() : c.type === 'boolean' ? new Bool() : new Utf8()
      return [c.name, vectorFromArray(rows.map((r) => cell(r[c.name], c)) as never[], type)]
    }),
  )
  return through(tableToIPC(new Table(vectors), 'stream'), new CompressionStream('gzip'))
}

/** The rows back from the file's bytes, typed by the dataset's columns. */
export async function decodeDatasetFile(bytes: Uint8Array, columns: ColumnInfo[]): Promise<DataRecord[]> {
  const table = tableFromIPC(await through(bytes, new DecompressionStream('gzip')))
  const cols = columns.map((c) => ({ c, data: table.getChild(c.name) }))
  const rows: DataRecord[] = []
  for (let i = 0; i < table.numRows; i++) rows.push(Object.fromEntries(cols.map(({ c, data }) => [c.name, value(data?.get(i), c)])))
  return rows
}

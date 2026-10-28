// Hosts the SQL engine's allowed extensions with the app: downloads each
// `hosted` one from DuckDB's repository into public/duckdb-ext/ (served as
// <base>duckdb-ext/<version>/<platform>/<name>.duckdb_extension.wasm), so the
// app doesn't depend on DuckDB's servers at run time. Runs before the build
// on Netlify (or with FETCH_DUCKDB_EXT=1); elsewhere it does nothing, and the
// app falls back to DuckDB's repository. A failed download never fails the build.
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const spec = JSON.parse(readFileSync(join(root, 'src/shared/sqlExtensions.json'), 'utf8'))

if (!process.env.NETLIFY && !process.env.FETCH_DUCKDB_EXT) {
  console.log('duckdb extensions: not fetched (only on Netlify, or with FETCH_DUCKDB_EXT=1); the app will load them from DuckDB')
  process.exit(0)
}

for (const x of spec.extensions.filter((e) => e.hosted)) {
  const path = `${spec.duckdbVersion}/${spec.platform}/${x.name}.duckdb_extension.wasm`
  const out = join(root, 'public/duckdb-ext', path)
  try {
    if ((await stat(out).catch(() => null))?.size) {
      console.log(`duckdb extensions: ${x.name} already here`)
      continue
    }
    const res = await fetch(`https://extensions.duckdb.org/${path}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, bytes)
    console.log(`duckdb extensions: ${x.name} ${(bytes.length / 1e6).toFixed(1)} MB → public/duckdb-ext/${path}`)
  } catch (e) {
    console.warn(`duckdb extensions: couldn't fetch ${x.name} (${e.message}); the app will load it from DuckDB`)
  }
}

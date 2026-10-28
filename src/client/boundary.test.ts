// The client / server boundary, enforced: components and client code reach
// data only through requests (api.ts) and the records reader (db.ts). They
// never import the server, the device database, the source readers or the
// exporters, and fetch nothing but the app's own version file.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(ts|vue)$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : []
  })
}

const CLIENT = [...files('src/components'), ...files('src/client'), 'src/App.vue', 'src/main.ts']
/** Modules only the server may import (types are fine). */
const SERVER_ONLY = [/\/server\//, /\/shared\/idb$/, /\/lib\/arcgis$/, /\/lib\/data\/connectors$/, /\/lib\/data\/csv$/, /\/lib\/dataset\/profile$/, /\/lib\/data\/boundaryTables$/]

describe('client / server boundary', () => {
  it("client code imports nothing server-only (types aside)", () => {
    const bad: string[] = []
    for (const f of CLIENT) {
      // client/db.ts opens the device database read-only: the one allowed use of idb.
      if (f === join('src', 'client', 'db.ts')) continue
      // worker startup lives in client/api.ts (`new Worker(new URL('../server/worker.ts'…))`): not an import.
      for (const m of readFileSync(f, 'utf8').matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)) {
        if (SERVER_ONLY.some((r) => r.test(m[1].replace(/\.(ts|vue)$/, '')))) bad.push(`${f}: ${m[1]}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('client code fetches nothing but the version file, and never reads data rows', () => {
    const bad: string[] = []
    for (const f of [...CLIENT, 'src/lib/useVersionCheck.ts']) {
      const text = readFileSync(f, 'utf8')
      if (/\bfetch\(/.test(text) && !f.endsWith('useVersionCheck.ts')) bad.push(`${f}: fetch`)
      if (/\breadRows\(/.test(text)) bad.push(`${f}: readRows`)
    }
    expect(bad).toEqual([])
  })
})

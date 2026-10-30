import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'
import { documentFiles, filesDocument, unzipDocument, zipDocument, zipName } from './files'
import { parseWorkspaceFile, type WorkspaceFile } from './file'

const load = (path: string): WorkspaceFile => {
  const p = parseWorkspaceFile(readFileSync(path, 'utf8'))
  if (!p.ok) throw new Error(p.error)
  return p.file
}
const DEFAULT = 'defaults/socioeconomic/workspace.powergis.json'
const FIXTURES = ['tests/fixtures/socioeconomic.powergis.json', 'tests/fixtures/state-income.powergis.json', 'tests/fixtures/utilities-join.powergis.json']

describe('workspace documents as files and zips', () => {
  it.each([DEFAULT, ...FIXTURES])('%s: document → files → document, and → zip → document, unchanged', (path) => {
    const file = load(path)
    const back = filesDocument(documentFiles(file))
    expect(back).toEqual({ ok: true, file })
    expect(unzipDocument(zipDocument(file))).toEqual({ ok: true, file })
  })

  it('lays the files out as the agent sees them: SQL in its own files, never in JSON', () => {
    const file = load(DEFAULT)
    const files = documentFiles(file)
    const t = file.transforms[0]
    expect(files.get(`transforms/${t.id}.${t.outputs[0].key}.sql`)).toBe(`${t.outputs[0].sql}\n`)
    expect(JSON.parse(files.get(`transforms/${t.id}.json`)!)).not.toHaveProperty('outputs.0.sql')
    expect(JSON.parse(files.get('workspace.json')!)).toMatchObject({ format: 'powergis-workspace', version: 2, name: file.name, transforms: file.transforms.map((x) => x.id) })
    expect(JSON.parse(files.get(`visualizations/${file.visualizations[0].id}.json`)!)).toMatchObject({ name: file.visualizations[0].name, style: file.visualizations[0].style })
    expect(files.get('overview.md')).toContain(file.name)
  })

  it('reads a zip re-made from the unzipped folder (one top folder, Mac extras), with an edited SQL file', () => {
    const file = load(DEFAULT)
    const t = file.transforms[0]
    const entries: Record<string, Uint8Array> = { '__MACOSX/._x': strToU8('junk'), 'My map/.DS_Store': strToU8('junk') }
    for (const [p, text] of documentFiles(file)) entries[`My map/${p}`] = strToU8(text)
    entries[`My map/transforms/${t.id}.${t.outputs[0].key}.sql`] = strToU8('SELECT 1 AS x\n')
    const r = unzipDocument(zipSync(entries))
    if (!r.ok) throw new Error(r.error)
    expect(r.file.transforms[0].outputs[0].sql).toBe('SELECT 1 AS x')
    expect(r.file.visualizations).toEqual(file.visualizations)
  })

  it('names what is wrong: not a zip, a missing file, broken JSON', () => {
    expect(unzipDocument(strToU8('hello'))).toMatchObject({ ok: false, error: expect.stringContaining('Not a zip') })
    const files = documentFiles(load(DEFAULT))
    const t = load(DEFAULT).transforms[0]
    const noSql = new Map(files)
    noSql.delete(`transforms/${t.id}.${t.outputs[0].key}.sql`)
    expect(filesDocument(noSql)).toMatchObject({ ok: false, error: expect.stringContaining(`transforms/${t.id}.${t.outputs[0].key}.sql is missing`) })
    const broken = new Map(files).set('workspace.json', '{ nope')
    expect(filesDocument(broken)).toMatchObject({ ok: false, error: expect.stringContaining("workspace.json isn't valid JSON") })
    expect(zipName('County score: v2')).toBe('County-score-v2.powergis.zip')
  })
})

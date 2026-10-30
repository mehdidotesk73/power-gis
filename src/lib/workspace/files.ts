// A workspace document (format v2) as a folder of small files — what Download
// puts in a zip and Load reads back. The layout is the agent's (lib/agent/
// workspaceFiles.ts), so people and the agent see one workspace the same way:
//
//   workspace.json                    format, version, name, requires, and the ids in order:
//                                     datasetIds, transforms, visualizations (draw order)
//   datasets.json                     every dataset pointed at, by id: what the workspace knows of it
//   transforms/<id>.json              one transform: name, inputs, outputs (key, name, outputId), requires
//   transforms/<id>.<key>.sql         that output's SQL, plain
//   visualizations/<id>.json          one visualization, every setting
//   overview.md                       generated, for people (ignored when loading)
//
// An item's id is its file name; SQL is never inside JSON. Reading goes back
// through parseWorkspaceObject, so a zip is checked like any document.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { overviewOf, parseWorkspaceObject, type Parsed, type WorkspaceFile } from './file'

/** Path → contents, paths without a leading slash. */
export type Files = Map<string, string>

export const INDEX = 'workspace.json'
export const DATASETS = 'datasets.json'
export const OVERVIEW = 'overview.md'
export const transformPath = (id: string) => `transforms/${id}.json`
export const sqlPath = (id: string, key: string) => `transforms/${id}.${key}.sql`
export const vizPath = (id: string) => `visualizations/${id}.json`

const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
/** Every SQL file ends in one newline more than its SQL, which reading takes off again. */
const sqlText = (sql: string) => `${sql}\n`
const fromSqlText = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text)

/** The document as files. */
export function documentFiles(file: WorkspaceFile): Files {
  const files: Files = new Map()
  files.set(
    INDEX,
    pretty({
      format: file.format,
      version: file.version,
      name: file.name,
      ...(file.workspaceId ? { workspaceId: file.workspaceId } : {}),
      ...(file.exportedAt ? { exportedAt: file.exportedAt } : {}),
      ...(file.requires?.length ? { requires: file.requires } : {}),
      datasetIds: file.datasetIds,
      transforms: file.transforms.map((t) => t.id),
      visualizations: file.visualizations.map((v) => v.id),
    }),
  )
  files.set(DATASETS, pretty(Object.fromEntries(file.datasets.map(({ id, ...fact }) => [id, fact]))))
  for (const t of file.transforms) {
    files.set(
      transformPath(t.id),
      pretty({
        name: t.name,
        inputs: t.inputs,
        outputs: t.outputs.map((o) => ({ key: o.key, name: o.name, ...(o.outputId ? { outputId: o.outputId } : {}) })),
        ...(t.requires?.length ? { requires: t.requires } : {}),
      }),
    )
    for (const o of t.outputs) files.set(sqlPath(t.id, o.key), sqlText(o.sql))
  }
  for (const v of file.visualizations) {
    const { id: _id, ...settings } = v
    files.set(vizPath(v.id), pretty(settings))
  }
  files.set(OVERVIEW, overviewOf(file))
  return files
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const idList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Files back into a document, checked like any document; a missing or broken file is named. */
export function filesDocument(files: Files): Parsed {
  const json = (path: string): Obj => {
    const text = files.get(path)
    if (text === undefined) throw new Error(`${path} is missing`)
    let v: unknown
    try {
      v = JSON.parse(text)
    } catch (e) {
      throw new Error(`${path} isn't valid JSON (${(e as Error).message})`)
    }
    if (!isObj(v)) throw new Error(`${path} must hold a JSON object`)
    return v
  }
  try {
    const index = json(INDEX)
    for (const k of ['datasetIds', 'transforms', 'visualizations']) if (!idList(index[k])) throw new Error(`${INDEX}: "${k}" must be a list of ids`)
    const facts = files.has(DATASETS) ? json(DATASETS) : {}
    const transforms = (index.transforms as string[]).map((id) => {
      const t = json(transformPath(id))
      const outputs = Array.isArray(t.outputs) ? t.outputs : []
      return {
        ...t,
        id,
        outputs: outputs.map((o: unknown) => {
          if (!isObj(o) || typeof o.key !== 'string') throw new Error(`${transformPath(id)}: every output needs a "key"`)
          const sql = files.get(sqlPath(id, o.key))
          if (sql === undefined) throw new Error(`${sqlPath(id, o.key)} is missing`)
          return { ...o, sql: fromSqlText(sql) }
        }),
      }
    })
    const visualizations = (index.visualizations as string[]).map((id) => ({ ...json(vizPath(id)), id }))
    const { transforms: _t, visualizations: _v, ...rest } = index
    return parseWorkspaceObject({
      ...rest,
      datasets: Object.entries(facts).map(([id, fact]) => ({ ...(isObj(fact) ? fact : {}), id })),
      transforms,
      visualizations,
    })
  } catch (e) {
    return { ok: false, error: `Not a PowerGIS workspace: ${(e as Error).message}` }
  }
}

/** The document as a zip of its files. */
export function zipDocument(file: WorkspaceFile): Uint8Array {
  return zipSync(Object.fromEntries([...documentFiles(file)].map(([path, text]) => [path, strToU8(text)])), { level: 6 })
}

/**
 * A zip back into a document. A zip made from an unzipped folder holds its
 * files under the folder's name: that one top folder is looked through, and
 * the Mac's extras (__MACOSX/, .DS_Store) are skipped.
 */
export function unzipDocument(bytes: Uint8Array): Parsed {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (e) {
    return { ok: false, error: `Not a zip file (${(e as Error).message})` }
  }
  const paths = Object.keys(entries).filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX/') && !p.split('/').pop()!.startsWith('.'))
  const top = paths[0]?.split('/')[0]
  const prefix = top && paths.includes(`${top}/${INDEX}`) && paths.every((p) => p.startsWith(`${top}/`)) ? `${top}/` : ''
  const files: Files = new Map(paths.map((p) => [p.startsWith(prefix) ? p.slice(prefix.length) : p, strFromU8(entries[p])]))
  return filesDocument(files)
}

/** Download / Load file names: `<name>.powergis.zip`. */
export const zipName = (name: string) => `${name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'workspace'}.powergis.zip`

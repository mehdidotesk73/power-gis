// The server: every request that changes the database or does heavy work.
// It writes the database and answers with pointers (ids) or small results.
// Runs in a Web Worker today (worker.ts); the handlers don't know that, so
// they can move behind HTTP later. Errors come back as readable results,
// never as throws.

import type { ApiError, ApiResult, Caller, Payload, RequestType, Response, UploadSource } from '../shared/api'
import { builtinTable, BUILTIN_TABLES, type BuiltinTable } from '../shared/builtins'
import type { Database } from '../shared/database'
import { dataTableName, type DatasetRecord, type SyncState, type TransformInputRef, type TransformRecord, type VisualizationRecord, type WorkspaceRecord } from '../shared/records'
import { featureTable, type DataRecord } from '../lib/data/connectors'
import { parseCsv } from '../lib/data/csv'
import { fetchArcGISLayer, importJSON, toCSV, toEsriFeatureSet, toGeoJSON } from '../lib/arcgis'
import { isSupportedBinding, type GeometryBinding } from '../lib/dataset/binding'
import { inferColumns, isGeometryColumn, type ColumnInfo } from '../lib/dataset/columns'
import { newId } from '../lib/dataset/dataset'
import { bindingInfo, findIndex, groupDataset, queryValues, type FindIndex, type Grouped } from '../lib/dataset/query'
import { profileRows } from '../lib/dataset/profile'
import { visualizationLayer } from '../lib/dataset/visualization'
import { parseWorkspaceFile, parseWorkspaceObject, pointers, replaceDatasetIds, type MissingDataset, type WorkspaceFile } from '../lib/workspace/file'
import { canManage, canShare, MAX_CLOUD_FILE, type Access, type CloudDataset, type CloudMember, type CloudStore } from '../shared/cloud'
import { decodeDatasetFile, encodeDatasetFile } from './datasetFile'
import { createSqlRunner, type SqlEngine, type SqlInput } from './sql'

export interface ServerEnv {
  /** A built-in table's rows (the default folder's CSVs, boundary polygons). */
  readBuiltin(table: string, baseUrl: string): Promise<DataRecord[]>
  /** The built-in tables: the active default folder's, unless given (tests give their own). */
  builtins?: BuiltinTable[]
  fetchImpl?: typeof fetch
  /** Opens the SQL engine (DuckDB) on first use. Without one, transforms are unsupported. */
  sql?: () => Promise<SqlEngine>
  /** The default workspace file's text (the default folder's workspace.powergis.json). */
  readDefaultWorkspace?(baseUrl: string): Promise<string>
  /** The cloud, as the user whose access token it is (Supabase). Without it, cloud requests are unsupported. */
  cloud?: (accessToken: string) => CloudStore
}

class Failure extends Error {
  constructor(
    readonly code: ApiError['code'],
    message: string,
  ) {
    super(message)
  }
}
const fail = (code: ApiError['code'], message: string): never => {
  throw new Failure(code, message)
}

type Handlers = { [K in RequestType]: (p: Payload<K>, caller: Caller) => Promise<Response<K>> }

/** Requests that change existing datasets; an agent may make them only on local ones. */

export function createServer(db: Database, env: ServerEnv) {
  const builtins = env.builtins ?? BUILTIN_TABLES
  let baseUrl = '/'
  // The device's one local user: found or made once, on first need (init or a save),
  // so a restarted worker that missed init still knows who saves.
  let userReady: Promise<string> | null = null
  const ensureUser = () =>
    (userReady ??= (async () => {
      const users = await db.list('users')
      if (users.length) return users[0].id
      const t = now()
      const id = newId()
      await db.put('users', { id, name: 'Local user', createdAt: t, updatedAt: t })
      return id
    })().catch((e) => {
      userReady = null
      throw e
    }))
  const now = () => new Date().toISOString()
  /** The cloud as the signed-in user (setAuth), or null. */
  let cloud: CloudStore | null = null
  const signedIn = () => cloud ?? fail('unsupported', 'Sign in to use the cloud')

  // Grouping a table onto features is the expensive part; visualizations of
  // the same dataset and binding share it. Dropped whenever a dataset changes.
  const groupedCache = new Map<string, Promise<{ g: Grouped; columns: ColumnInfo[]; find?: FindIndex }>>()
  const forget = (datasetId: string) => {
    for (const k of groupedCache.keys()) if (k.startsWith(`${datasetId}|`)) groupedCache.delete(k)
  }

  const sql = env.sql ? createSqlRunner(env.sql) : null

  /** A transform's inputs as SQL tables (loaded only when their data changed). */
  async function sqlInputs(inputs: TransformInputRef[]): Promise<SqlInput[]> {
    if (!inputs.length) fail('invalid', 'A transform needs at least one input dataset')
    return Promise.all(
      inputs.map(async (i) => {
        const ds = await dataset(i.datasetId)
        return {
          alias: i.alias,
          label: ds.name,
          key: ds.id,
          version: `${ds.id}|${ds.updatedAt}`,
          columns: ds.columns,
          rows: async () => (await db.readRows(ds.table)) ?? fail('not_found', `Dataset "${ds.name}" has no data table`),
        }
      }),
    )
  }
  async function runSql(query: string, inputs: TransformInputRef[], limit?: number, offset?: number) {
    if (!sql) fail('unsupported', 'SQL transforms are not available here')
    const tables = await sqlInputs(inputs)
    try {
      return await sql!.run(query, tables, limit, offset)
    } catch (e) {
      // SQL mistakes (and DuckDB's own messages) come back as readable errors.
      return fail('invalid', (e as Error).message)
    }
  }

  async function dataset(id: string): Promise<DatasetRecord> {
    return (await db.get('datasets', id)) ?? fail('not_found', `No dataset "${id}"`)
  }

  // ── cloud links ──────────────────────────────────────────────────────────
  // Every dataset's rows are on this device; a linked one also has a cloud
  // dataset (its own id) and the version this copy last matched. Only the
  // user's syncs (push / pull) move rows between them; never an agent.
  const SYNC_REFUSAL = 'Only the user syncs datasets with the cloud.'

  /** Writes a cloud dataset into local copy `id` (made if new), linked to it and matching its version. */
  async function pull(c: CloudStore, cd: CloudDataset, id: string): Promise<DatasetRecord> {
    if (!cd.hasFile) fail('not_found', `"${cd.name}" has no rows in the cloud yet`)
    const rows = await decodeDatasetFile(await c.readFile(cd.id), cd.columns)
    const have = await db.get('datasets', id)
    const t = now()
    const { store: _old, ...kept } = have ?? ({} as Partial<DatasetRecord>)
    const record: DatasetRecord = {
      ...kept,
      id,
      table: have?.table ?? dataTableName(id),
      name: cd.name,
      ...(cd.description ? { description: cd.description } : { description: undefined }),
      columns: cd.columns,
      rowCount: rows.length,
      profile: profileRows(rows, cd.columns),
      origin: cd.meta.origin ?? have?.origin ?? 'Cloud',
      ...(cd.meta.extensions ? { extensions: cd.meta.extensions } : {}),
      link: { cloudId: cd.id, version: cd.updatedAt },
      createdAt: have?.createdAt ?? t,
      updatedAt: t,
    }
    await db.writeRows(record.table, rows)
    await db.put('datasets', record)
    forget(id)
    return record
  }

  /** Uploads a local copy to cloud dataset `cloudId` (made if new); answers the cloud's new version. */
  async function upload(c: CloudStore, ds: DatasetRecord, cloudId: string): Promise<string> {
    const rows = (await db.readRows(ds.table)) ?? fail('not_found', `Dataset "${ds.name}" has no data table`)
    const file = await encodeDatasetFile(ds.columns, rows)
    if (file.byteLength > MAX_CLOUD_FILE) {
      fail('invalid', `"${ds.name}" is too large for cloud storage (${(file.byteLength / 1e6).toFixed(1)} MB compressed; files can be up to ${MAX_CLOUD_FILE / 1024 / 1024} MB)`)
    }
    const { updatedAt } = await c.putDataset({ id: cloudId, name: ds.name, description: ds.description ?? '', columns: ds.columns, rowCount: ds.rowCount, meta: { origin: ds.origin, ...(ds.extensions ? { extensions: ds.extensions } : {}) } }, file)
    return updatedAt
  }

  /** A linked dataset's cloud id. */
  async function linkOf(id: string): Promise<string> {
    const ds = await dataset(id)
    return ds.link?.cloudId ?? fail('invalid', `"${ds.name}" isn't in the cloud: link it first (its menu → Link to cloud)`)
  }
  /** A cloud dataset's people, and the user's own access to it. */
  async function people(c: CloudStore, cloudId: string): Promise<{ members: CloudMember[]; access?: Access }> {
    const members = await c.members(cloudId)
    if (!members.length) fail('not_found', "It's no longer in the cloud, or no longer shared with you")
    const access = members.find((m) => m.you)?.access
    return { members, ...(access ? { access } : {}) }
  }
  /** A linked copy's state against its cloud dataset (undefined: gone from the cloud). */
  const stateOf = (link: NonNullable<DatasetRecord['link']>, cd: CloudDataset | undefined): SyncState =>
    !cd ? 'gone' : cd.updatedAt === link.version ? (link.changed ? 'ahead' : 'synced') : link.changed ? 'both' : 'behind'

  function grouped(datasetId: string, binding: GeometryBinding) {
    const key = `${datasetId}|${JSON.stringify(binding)}`
    let p = groupedCache.get(key)
    if (!p) {
      p = (async () => {
        const ds = await dataset(datasetId)
        if (!isSupportedBinding(binding)) fail('invalid', 'Visualizations draw a geometry column (join region codes onto a boundary dataset in a transform)')
        const cols = ds.columns.map((c) => c.name)
        for (const c of [binding.column, binding.label]) if (c && !cols.includes(c)) fail('invalid', `Dataset "${ds.name}" has no column "${c}"`)
        const type = ds.columns.find((c) => c.name === binding.column)!.type
        if (!isGeometryColumn(type)) fail('invalid', `"${binding.column}" is a ${type} column, not a geometry column`)
        const rows = (await db.readRows(ds.table)) ?? fail('not_found', `Dataset "${ds.name}" has no data table`)
        return { g: groupDataset(rows, ds.columns, binding), columns: ds.columns }
      })()
      p.catch(() => groupedCache.delete(key))
      groupedCache.set(key, p)
    }
    return p
  }

  async function readSource(source: UploadSource): Promise<{ rows: DataRecord[]; origin: string; name: string; description?: string; extensions?: Record<string, unknown> }> {
    switch (source.kind) {
      case 'csv':
        return { rows: parseCsv(await source.file.text()), origin: `Device · ${source.file.name}`, name: source.file.name.replace(/\.csv$/i, '') }
      case 'json': {
        const layer = importJSON(JSON.parse(await source.file.text()), source.file.name.replace(/\.(geo)?json$/i, ''))
        return { rows: featureTable(layer.features), origin: `Device · ${source.file.name}`, name: layer.name }
      }
      case 'arcgis': {
        const layer = await fetchArcGISLayer(source.url, { maxFeatures: 5000, fetchImpl: env.fetchImpl })
        return { rows: featureTable(layer.features), origin: `ArcGIS · ${layer.name}`, name: layer.name }
      }
      case 'builtin': {
        const b = builtinTable(source.table, builtins) ?? fail('not_found', `No built-in table "${source.table}"`)
        return { rows: await env.readBuiltin(b.table, baseUrl), origin: `Built-in · ${b.table}`, name: b.label, description: b.description, extensions: { builtin: b.table, version: b.version } }
      }
    }
  }

  /**
   * Makes a workspace document's dataset ids real on this device, dataset by dataset:
   * an id (or one it's the same as) that's here is used; a built-in is reused or
   * uploaded; a transform's output is reused when a copy made from the same SQL is
   * here, or made by running the transform once its inputs are (in any order);
   * anything else is `missing`, with why. Copies remember the ids they stand for
   * (`extensions.copyOf`), so opening the same document again reuses them.
   */
  async function openDocument(doc: WorkspaceFile): Promise<{ file: WorkspaceFile; missing: MissingDataset[]; failed: { name: string; reason: string }[] }> {
    // Signed in, datasets not here are pulled from the cloud when they're linked (by their cloud id),
    // or found there anyway (linked after the document was saved: their first link used their id).
    // Datasets already here keep their local copy, whatever the cloud has: syncing is the user's.
    const fromCloud = new Map<string, CloudDataset>() // fact id → its cloud dataset
    if (cloud) {
      const here = new Set((await db.list('datasets')).flatMap((d) => [d.id, ...(Array.isArray(d.extensions?.copyOf) ? (d.extensions.copyOf as string[]) : [])]))
      const wanted = doc.datasets.filter((f) => ![f.id, ...(f.sameAs ?? [])].some((x) => here.has(x)))
      const found = await cloud.datasets(wanted.map((f) => f.cloudId ?? f.id)).catch(() => [] as CloudDataset[])
      for (const f of wanted) {
        const cd = found.find((x) => x.id === (f.cloudId ?? f.id))
        if (cd) fromCloud.set(f.id, cd)
      }
    }
    const records = await db.list('datasets')
    const copyOf = (d: DatasetRecord) => (Array.isArray(d.extensions?.copyOf) ? (d.extensions.copyOf as string[]) : [])
    /** This device's dataset for a fact: the same id, or a copy made for it (or for one it's the same as). */
    const find = (ids: string[]) => records.find((d) => ids.includes(d.id)) ?? records.find((d) => copyOf(d).some((x) => ids.includes(x)))
    const resolved = new Map<string, string>()
    const missing: MissingDataset[] = []
    const failed: { name: string; reason: string }[] = []
    const lost = (fact: WorkspaceFile['datasets'][number], why: MissingDataset['why']) => missing.push({ id: fact.id, name: fact.name, ...(fact.rows !== undefined ? { rows: fact.rows } : {}), why })

    for (const fact of doc.datasets) {
      const ids = [fact.id, ...(fact.sameAs ?? [])]
      const o = fact.origin
      const there = fromCloud.get(fact.id)
      if (o.kind === 'output' && !there) continue // below, with its transform (a linked one is pulled instead)
      const here = find(ids)
      if (here) resolved.set(fact.id, here.id)
      else if (there && cloud) {
        try {
          records.push(await pull(cloud, there, fact.id))
          resolved.set(fact.id, fact.id)
        } catch {
          lost(fact, 'cloud')
        }
      } else if (o.kind === 'builtin') {
        const b = builtinTable(o.table, builtins)
        if (!b) lost(fact, 'builtin')
        else {
          const have = records.find((d) => d.extensions?.builtin === o.table && d.extensions?.version === b.version)
          resolved.set(fact.id, have?.id ?? (await handlers.uploadDataset({ source: { kind: 'builtin', table: o.table } }, 'user')).datasetId)
        }
      } else lost(fact, o.kind === 'upload' ? (fact.store === 'remote' ? 'cloud' : 'elsewhere') : 'unknown')
    }

    // Outputs: transforms run when all their inputs are resolved, in whatever order that allows.
    const facts = new Map(doc.datasets.map((d) => [d.id, d]))
    /** A transform that can't run here: its output is still usable if it's here or in the cloud. */
    const outputFromCloud = async (id: string): Promise<boolean> => {
      const here = find([id, ...(facts.get(id)?.sameAs ?? [])])
      if (here) return resolved.set(id, here.id), true
      const there = fromCloud.get(id)
      if (!there || !cloud) return false
      try {
        records.push(await pull(cloud, there, id))
        resolved.set(id, id)
        return true
      } catch {
        return false
      }
    }
    const pending = new Set(doc.transforms.map((t) => t.id))
    for (let progress = true; progress; ) {
      progress = false
      for (const t of doc.transforms) {
        if (!pending.has(t.id)) continue
        const inputs = t.inputs.map((i) => resolved.get(i.datasetId))
        if (t.inputs.some((i) => missing.some((m) => m.id === i.datasetId))) {
          failed.push({ name: t.name, reason: "an input dataset isn't on this device" })
          for (const o of t.outputs) if (o.outputId && facts.has(o.outputId) && !(await outputFromCloud(o.outputId))) lost(facts.get(o.outputId)!, 'output')
          pending.delete(t.id)
          continue
        }
        if (inputs.some((x) => !x)) continue // waits for another transform's output
        pending.delete(t.id)
        progress = true
        // Each output: a dataset here made from the same SQL is used as is; otherwise the transform runs (into a stale copy, if there is one).
        const targets = t.outputs.map((o) => {
          if (!o.outputId) return { o, use: undefined, run: false }
          const fact = facts.get(o.outputId)
          const here = find([o.outputId, ...(fact?.sameAs ?? [])])
          const sql = here?.extensions?.sql
          return { o, use: here?.id, run: !here || (typeof sql === 'string' && sql !== o.sql) }
        })
        if (targets.some((x) => x.run)) {
          try {
            const r = await handlers.runTransform(
              { transform: { ...t, id: `open-${t.id}`, inputs: t.inputs.map((i, k) => ({ ...i, datasetId: inputs[k]! })), outputs: targets.map(({ o, use }) => ({ ...o, outputId: use })) } },
              'user',
            )
            for (const x of targets) x.use = r.outputs.find((w) => w.key === x.o.key)!.datasetId
          } catch (e) {
            failed.push({ name: t.name, reason: (e as Error).message })
            for (const { o } of targets) if (o.outputId && facts.has(o.outputId) && !(await outputFromCloud(o.outputId))) lost(facts.get(o.outputId)!, 'output')
            continue
          }
        }
        for (const { o, use } of targets) {
          if (!o.outputId || !use) continue
          resolved.set(o.outputId, use)
          // Remember which ids this dataset stands for, so the next open reuses it.
          const d = (await db.get('datasets', use))!
          const stands = [...new Set([...copyOf(d), ...[o.outputId, ...(facts.get(o.outputId)?.sameAs ?? [])].filter((x) => x !== use)])]
          if (stands.length !== copyOf(d).length) await db.put('datasets', { ...d, extensions: { ...d.extensions, copyOf: stands } })
        }
      }
    }
    for (const t of doc.transforms) {
      if (!pending.has(t.id)) continue
      failed.push({ name: t.name, reason: "its inputs come from transforms that couldn't run" })
      for (const o of t.outputs) if (o.outputId && facts.has(o.outputId) && !(await outputFromCloud(o.outputId))) lost(facts.get(o.outputId)!, 'output')
    }
    // Pointers the document has no facts for (it always should) are missing too.
    for (const id of pointers(doc)) if (!resolved.has(id) && !missing.some((m) => m.id === id)) missing.push({ id, name: facts.get(id)?.name ?? 'Unknown dataset', why: 'unknown' })
    return { file: replaceDatasetIds(doc, (id) => resolved.get(id)), missing, failed }
  }

  const handlers: Handlers = {
    async init({ baseUrl: url }) {
      baseUrl = url
      return { userId: await ensureUser() }
    },

    async uploadDataset({ source, name }) {
      const src = await readSource(source)
      if (!src.rows.length) fail('invalid', 'That table has no rows')
      const rows = src.rows
      const columns = inferColumns(rows)
      const id = newId()
      const t = now()
      const record: DatasetRecord = {
        id,
        name: name?.trim() || src.name,
        table: dataTableName(id),
        columns,
        rowCount: rows.length,
        profile: profileRows(rows, columns),
        origin: src.origin,
        store: 'local',
        ...(src.description ? { description: src.description } : {}),
        createdAt: t,
        updatedAt: t,
        ...(src.extensions ? { extensions: src.extensions } : {}),
      }
      await db.writeRows(record.table, rows)
      await db.put('datasets', record)
      return { datasetId: id }
    },

    async updateDataset({ id, name, description, extensions }, caller) {
      const ds = await dataset(id)
      if (name !== undefined && !name.trim()) fail('invalid', 'A dataset needs a name')
      // A linked copy's new name or description is a change here, pushed with its next sync.
      const changes = (name !== undefined && name.trim() !== ds.name) || (description !== undefined && description !== (ds.description ?? ''))
      await db.put('datasets', {
        ...ds,
        ...(ds.link && changes ? { link: { ...ds.link, changed: true } } : {}),
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(extensions !== undefined ? { extensions: { ...ds.extensions, ...extensions } } : {}),
        // updatedAt stays: it marks when the rows changed (transforms compare it to know they're stale).
      })
      return { datasetId: id }
    },

    async deleteDataset({ id }, caller) {
      const ds = await dataset(id)
      // This device's copy only: its cloud dataset (if linked) stays (Delete from the cloud is separate).
      await db.dropRows(ds.table)
      await db.delete('datasets', id)
      const gone = new Set<string>()
      for (const v of await db.list('visualizations')) if (v.datasetId === id) (gone.add(v.id), await db.delete('visualizations', v.id))
      for (const w of await db.list('workspaces')) {
        if (!w.config.datasetIds.includes(id)) continue
        const config = { ...w.config, datasetIds: w.config.datasetIds.filter((d) => d !== id), visualizationIds: w.config.visualizationIds.filter((v) => !gone.has(v)) }
        await db.put('workspaces', { ...w, config, updatedAt: now() })
      }
      // A transform output that wrote this dataset makes a new one on its next run.
      for (const tr of await db.list('transforms')) {
        if (!tr.outputs?.some((o) => o.outputId === id)) continue
        await db.put('transforms', { ...tr, outputs: tr.outputs.map((o) => (o.outputId === id ? { ...o, outputId: undefined } : o)), updatedAt: now() })
      }
      forget(id)
      return { datasetId: id }
    },

    async linkToCloud({ id }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const c = signedIn()
      const ds = await dataset(id)
      if (ds.link) return { datasetId: id, cloudId: ds.link.cloudId, version: ds.link.version }
      if (typeof ds.extensions?.builtin === 'string') fail('invalid', `"${ds.name}" is a built-in table: every device makes its own, so it isn't linked`)
      // The cloud dataset takes this copy's id when it can (a uuid no cloud dataset has yet).
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const cloudId = UUID.test(id) && !(await c.datasets([id])).length ? id : newId()
      const version = await upload(c, ds, cloudId)
      await db.put('datasets', { ...(await dataset(id)), link: { cloudId, version } })
      return { datasetId: id, cloudId, version }
    },

    async pushDataset({ id, overwrite }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const c = signedIn()
      const ds = await dataset(id)
      const link = ds.link ?? fail('invalid', `"${ds.name}" isn't linked to the cloud`)
      const [cd] = await c.datasets([link.cloudId])
      if (cd && cd.access === 'read') fail('invalid', `You can only read "${cd.name}" in the cloud: pull it, or ask its owner for write access`)
      if (cd && cd.updatedAt !== link.version && !overwrite) fail('conflict', `"${ds.name}" changed in the cloud since this copy last matched it`)
      const version = await upload(c, ds, link.cloudId)
      await db.put('datasets', { ...(await dataset(id)), link: { cloudId: link.cloudId, version } })
      return { datasetId: id, version }
    },

    async pullDataset({ id, cloudId }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const c = signedIn()
      const have = await db.get('datasets', id)
      const target = have?.link?.cloudId ?? cloudId ?? fail('invalid', `"${have?.name ?? id}" isn't linked to the cloud`)
      const [cd] = await c.datasets([target])
      if (!cd) fail('not_found', 'That dataset is no longer in the cloud (or not shared with you)')
      const r = await pull(c, cd, id)
      return { datasetId: id, rowCount: r.rowCount }
    },

    async unlinkDataset({ id }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const { link: _gone, ...rest } = await dataset(id)
      await db.put('datasets', rest)
      return { datasetId: id }
    },

    async deleteFromCloud({ id }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const c = signedIn()
      const ds = await dataset(id)
      const link = ds.link ?? fail('invalid', `"${ds.name}" isn't linked to the cloud`)
      const [cd] = await c.datasets([link.cloudId])
      if (cd && cd.access !== 'owner') fail('invalid', `Only "${cd.name}"'s owner can delete it from the cloud`)
      if (cd) await c.deleteDataset(link.cloudId)
      const { link: _gone, ...rest } = ds
      await db.put('datasets', rest)
      return { datasetId: id }
    },

    async cloudStatus({ items }) {
      const c = signedIn()
      const wanted = await Promise.all(items.map(async (it) => ({ it, link: (await db.get('datasets', it.id))?.link })))
      const there = new Map((await c.datasets(wanted.map(({ it, link }) => link?.cloudId ?? it.cloudId ?? it.id))).map((cd) => [cd.id, cd]))
      return {
        datasets: wanted.map(({ it, link }) => {
          const cd = there.get(link?.cloudId ?? it.cloudId ?? it.id)
          // Not here yet: what the cloud has is newer than nothing.
          const state = link ? stateOf(link, cd) : cd ? ('behind' as const) : ('gone' as const)
          return { id: it.id, state, canPush: !!cd && cd.access !== 'read', ...(cd ? { version: cd.updatedAt } : {}) }
        }),
      }
    },

    async cloudDatasets(_, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const c = signedIn()
      const copies = new Map((await db.list('datasets')).flatMap((d) => (d.link ? [[d.link.cloudId, d.id] as const] : [])))
      return {
        datasets: (await c.listDatasets()).map((cd) => ({
          cloudId: cd.id,
          name: cd.name,
          description: cd.description,
          rows: cd.rowCount,
          access: cd.access,
          updatedAt: cd.updatedAt,
          ...(copies.has(cd.id) ? { localId: copies.get(cd.id) } : {}),
        })),
      }
    },

    async addFromCloud({ cloudId }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const c = signedIn()
      const all = await db.list('datasets')
      const copy = all.find((d) => d.link?.cloudId === cloudId)
      if (copy) return { datasetId: copy.id, created: false }
      const [cd] = await c.datasets([cloudId])
      if (!cd) fail('not_found', 'That dataset is no longer in the cloud (or not shared with you)')
      // Its own id when this device has nothing by that id (an unlinked copy keeps its own).
      const id = all.some((d) => d.id === cloudId) ? newId() : cloudId
      await pull(c, cd, id)
      return { datasetId: id, created: true }
    },

    async datasetMembers({ id }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      return people(signedIn(), await linkOf(id))
    },

    async shareDataset({ id, email, access }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const c = signedIn()
      const cloudId = await linkOf(id)
      const before = await people(c, cloudId)
      if (!canShare(before.access)) fail('invalid', 'Only its owner and people with write access can share it')
      if (!email.trim()) fail('invalid', 'Type the email of the person to share it with')
      const them = before.members.find((m) => m.email.toLowerCase() === email.trim().toLowerCase())
      if (them?.you) fail('invalid', 'That is you')
      if (them && !canManage(before.access, them).change) fail('invalid', `${them.name} has ${them.access} access, which you can't change`)
      await c.share(cloudId, email.trim(), access)
      return people(c, cloudId)
    },

    async setMemberAccess({ id, userId, access }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const c = signedIn()
      const cloudId = await linkOf(id)
      const before = await people(c, cloudId)
      const them = before.members.find((m) => m.userId === userId) ?? fail('not_found', 'That person has no access to it')
      if (!canManage(before.access, them).change) fail('invalid', `You can't change ${them.name}'s access`)
      await c.setAccess(cloudId, userId, access)
      return people(c, cloudId)
    },

    async removeMember({ id, userId }, caller) {
      if (caller === 'agent') fail('invalid', SYNC_REFUSAL)
      const c = signedIn()
      const cloudId = await linkOf(id)
      const before = await people(c, cloudId)
      const them = before.members.find((m) => m.userId === userId) ?? fail('not_found', 'That person has no access to it')
      if (!canManage(before.access, them).remove) fail('invalid', them.access === 'owner' ? 'The owner keeps their access' : `You can't remove ${them.name}`)
      await c.removeAccess(cloudId, userId)
      if (!them.you) return people(c, cloudId)
      // Left it: this copy stays, local only (the cloud dataset isn't the user's to sync any more).
      const { link: _gone, ...rest } = await dataset(id)
      await db.put('datasets', rest)
      return { members: [], left: true }
    },

    async previewTransform({ sql: query, inputs, limit, offset }) {
      return runSql(query, inputs, Math.min(limit ?? 20, 1000), offset)
    },

    async loadSqlExtensions({ names }) {
      if (!sql) fail('unsupported', 'SQL transforms are not available here')
      try {
        return { loaded: await sql!.load(names) }
      } catch (e) {
        return fail('failed', (e as Error).message)
      }
    },

    async runTransform({ transform }, caller) {
      if (!transform.name.trim()) fail('invalid', 'A transform needs a name')
      if (!transform.outputs?.length) fail('invalid', 'A transform needs at least one output')
      // Every output's SQL runs first; nothing is written unless all of them succeed.
      const results: { o: (typeof transform.outputs)[number]; out: Awaited<ReturnType<typeof runSql>> }[] = []
      for (const o of transform.outputs) {
        try {
          results.push({ o, out: await runSql(o.sql, transform.inputs) })
        } catch (e) {
          const label = o.name.trim() || transform.name.trim()
          fail(e instanceof Failure ? e.code : 'failed', transform.outputs.length > 1 ? `${label}: ${(e as Error).message}` : (e as Error).message)
        }
      }
      const t = now()
      const written: { key: string; datasetId: string; rowCount: number; created: boolean }[] = []
      for (const { o, out } of results) {
        const existing = o.outputId ? await db.get('datasets', o.outputId) : undefined
        const id = existing?.id ?? newId()
        const name = o.name.trim() || transform.name.trim()
        const record: DatasetRecord = {
          ...(existing ?? { id, table: dataTableName(id), origin: `Transform · ${transform.name.trim()}`, store: 'local' as const, name, createdAt: t }),
          columns: out.columns,
          rowCount: out.rows.length,
          profile: profileRows(out.rows, out.columns),
          // The SQL that wrote these rows: opening a workspace elsewhere compares it to tell a current copy from a stale one.
          extensions: { ...existing?.extensions, sql: o.sql },
          // A linked copy rewritten here: changed here (↑) until the user pushes it, or pulls the cloud's back.
          ...(existing?.link ? { link: { ...existing.link, changed: true } } : {}),
          updatedAt: t,
        }
        await db.writeRows(record.table, out.rows)
        await db.put('datasets', record)
        forget(id)
        written.push({ key: o.key, datasetId: id, rowCount: out.rows.length, created: !existing })
      }
      // What the SQL needs from the engine, for loading it ahead next time (a workspace's dependencies).
      const requires = [...new Set(results.flatMap((r) => r.out.extensions))].sort()
      // A saved transform remembers where each output went, and what it needs.
      const saved = await db.get('transforms', transform.id)
      if (saved) {
        const { requires: _old, ...rest } = saved
        const outputs = (saved.outputs ?? []).map((o) => ({ ...o, outputId: written.find((w) => w.key === o.key)?.datasetId ?? o.outputId }))
        await db.put('transforms', { ...rest, outputs, ...(requires.length ? { requires } : {}), updatedAt: t })
      }
      return { outputs: written, requires }
    },

    async datasetRows({ datasetId, limit, offset = 0 }) {
      const ds = await dataset(datasetId)
      const rows = (await db.readRows(ds.table)) ?? fail('not_found', `Dataset "${ds.name}" has no data table`)
      const n = Math.max(0, Math.min(limit ?? 20, 1000))
      return { columns: ds.columns, rows: rows.slice(offset, offset + n), rowCount: rows.length }
    },

    async exportVisualization({ visualization: v, format }) {
      const ds = await dataset(v.datasetId)
      const { g, columns } = await grouped(v.datasetId, v.binding)
      if (v.column !== '__rows' && !columns.some((c) => c.name === v.column)) fail('invalid', `Dataset has no column "${v.column}"`)
      const layer = visualizationLayer(queryValues(g, columns, v.column, v.aggregation), v, ds.name)
      const base = layer.id
      switch (format) {
        case 'geojson':
          return { fileName: `${base}.geojson`, mimeType: 'application/geo+json', text: JSON.stringify(toGeoJSON(layer)) }
        case 'agol':
          return { fileName: `${base}-arcgis.geojson`, mimeType: 'application/geo+json', text: JSON.stringify(toGeoJSON(layer, true)) }
        case 'esri':
          return { fileName: `${base}.esri.json`, mimeType: 'application/json', text: JSON.stringify(toEsriFeatureSet(layer)) }
        case 'csv':
          return { fileName: `${base}.csv`, mimeType: 'text/csv', text: toCSV(layer) }
      }
      return fail('invalid', `Unknown export format "${String(format)}"`)
    },

    /**
     * The default map, ready to open: its built-in datasets uploaded (or this device's current
     * copies reused), its transforms run in order (or an earlier output of the same SQL over the
     * same inputs reused), and the file's placeholders swapped for those datasets' ids.
     */
    async seedDefaultWorkspace() {
      if (!env.readDefaultWorkspace) return fail('unsupported', 'No default workspace here')
      const parsed = parseWorkspaceFile(await env.readDefaultWorkspace(baseUrl))
      if (!parsed.ok) return fail('failed', `default workspace: ${parsed.error}`)
      // What couldn't be made here (a transform needing an extension this device can't download, say)
      // is reported, as for any opened workspace: the map opens with the rest.
      return openDocument(parsed.file)
    },

    async openDocument({ file }) {
      const parsed = parseWorkspaceObject(file)
      if (!parsed.ok) return fail('invalid', parsed.error)
      return openDocument(parsed.file)
    },

    async setAuth({ accessToken }) {
      cloud = accessToken && env.cloud ? env.cloud(accessToken) : null
      return { signedIn: !!cloud }
    },

    async cloudWorkspace() {
      const w = await signedIn().defaultWorkspace()
      return { workspace: w && { name: w.name, updatedAt: w.updatedAt, file: w.file } }
    },

    async saveCloudWorkspace({ file, overview }) {
      const { updatedAt } = await signedIn().saveDefaultWorkspace({ name: file.name, file: { ...file, exportedAt: now() }, overview })
      return { updatedAt }
    },

    async profileDataset({ datasetId }) {
      const ds = await dataset(datasetId)
      if (ds.profile) return ds.profile
      const rows = (await db.readRows(ds.table)) ?? fail('not_found', `Dataset "${ds.name}" has no data table`)
      const profile = profileRows(rows, ds.columns)
      await db.put('datasets', { ...ds, profile })
      return profile
    },

    async describeBinding({ datasetId, binding }) {
      const { g, columns } = await grouped(datasetId, binding)
      return bindingInfo(g, columns, binding)
    },

    async queryVisualization({ datasetId, binding, column, aggregation }) {
      const { g, columns } = await grouped(datasetId, binding)
      if (column !== '__rows' && !columns.some((c) => c.name === column)) fail('invalid', `Dataset has no column "${column}"`)
      return queryValues(g, columns, column, aggregation)
    },

    async findIndex({ datasetId, binding }) {
      const entry = await grouped(datasetId, binding)
      entry.find ??= findIndex(entry.g, entry.columns, binding.label)
      return { entries: entry.find.entries }
    },

    async findFeatures({ datasetId, binding, column, value }) {
      const entry = await grouped(datasetId, binding)
      entry.find ??= findIndex(entry.g, entry.columns, binding.label)
      return { keys: entry.find.keys.get(`${column}\u0000${value}`) ?? [] }
    },

    async featureRows({ datasetId, binding, key }) {
      const { g } = await grouped(datasetId, binding)
      return g.groups.find((x) => x.key === key)?.rows ?? []
    },

    async saveWorkspace({ id, name, config, visualizations, transforms = [] }) {
      if (!name.trim()) fail('invalid', 'A workspace needs a name')
      const existing = id ? await db.get('workspaces', id) : undefined
      if (id && !existing) fail('not_found', `No workspace "${id}"`)
      const listed = new Set(config.datasetIds)
      // Every listed dataset must be here, unless it's one the workspace knows is unavailable on this device.
      for (const d of config.datasetIds) if (!config.unavailable?.[d]) await dataset(d)
      const t = now()
      for (const v of visualizations) {
        if (!listed.has(v.datasetId)) fail('invalid', `Visualization "${v.name}" uses a dataset that isn't in the workspace`)
        const old = await db.get('visualizations', v.id)
        const record: VisualizationRecord = { id: v.id, name: v.name, datasetId: v.datasetId, settings: v.settings, createdAt: old?.createdAt ?? t, updatedAt: t }
        await db.put('visualizations', record)
      }
      const keep = new Set(visualizations.map((v) => v.id))
      for (const old of existing?.config.visualizationIds ?? []) if (!keep.has(old)) await db.delete('visualizations', old)
      for (const tr of transforms) {
        if (!tr.name.trim()) fail('invalid', 'A transform needs a name')
        const old = await db.get('transforms', tr.id)
        const record: TransformRecord = {
          id: tr.id,
          name: tr.name.trim(),
          inputs: tr.inputs.map((i) => ({ datasetId: i.datasetId, alias: i.alias })),
          outputs: tr.outputs.map((o) => ({ key: o.key, name: o.name, sql: o.sql, ...(o.outputId ? { outputId: o.outputId } : {}) })),
          ...(tr.requires?.length ? { requires: [...tr.requires] } : {}),
          createdAt: old?.createdAt ?? t,
          updatedAt: t,
        }
        await db.put('transforms', record)
      }
      const keepT = new Set(transforms.map((x) => x.id))
      for (const old of existing?.config.transformIds ?? []) if (!keepT.has(old)) await db.delete('transforms', old)
      const record: WorkspaceRecord = {
        id: existing?.id ?? newId(),
        name: name.trim(),
        ownerId: existing?.ownerId ?? (await ensureUser()),
        config: {
          datasetIds: [...config.datasetIds],
          visualizationIds: visualizations.map((v) => v.id),
          transformIds: transforms.map((x) => x.id),
          ...(config.unavailable && Object.keys(config.unavailable).length ? { unavailable: config.unavailable } : {}),
        },
        createdAt: existing?.createdAt ?? t,
        updatedAt: t,
      }
      await db.put('workspaces', record)
      return { workspaceId: record.id }
    },

    async deleteWorkspace({ id }) {
      const w = (await db.get('workspaces', id)) ?? fail('not_found', `No workspace "${id}"`)
      for (const v of w.config.visualizationIds) await db.delete('visualizations', v)
      for (const x of w.config.transformIds ?? []) await db.delete('transforms', x)
      await db.delete('workspaces', id)
      return { workspaceId: id }
    },
  }

  return {
    async handle<K extends RequestType>(type: K, payload: Payload<K>, caller: Caller = 'user'): Promise<ApiResult<Response<K>>> {
      const h = handlers[type] as ((p: Payload<K>, c: Caller) => Promise<Response<K>>) | undefined
      if (!h) return { ok: false, error: { code: 'unsupported', message: `Unknown request "${String(type)}"` } }
      try {
        return { ok: true, data: await h(payload, caller) }
      } catch (e) {
        return { ok: false, error: e instanceof Failure ? { code: e.code, message: e.message } : { code: 'failed', message: (e as Error).message ?? String(e) } }
      }
    },
  }
}
export type Server = ReturnType<typeof createServer>

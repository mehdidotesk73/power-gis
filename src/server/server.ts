// The server: every request that changes the database or does heavy work.
// It writes the database and answers with pointers (ids) or small results.
// Runs in a Web Worker today (worker.ts); the handlers don't know that, so
// they can move behind HTTP later. Errors come back as readable results,
// never as throws.

import type { ApiError, ApiResult, Payload, RequestType, Response, UploadSource } from '../shared/api'
import { builtinTable } from '../shared/builtins'
import type { Database } from '../shared/database'
import { dataTableName, type DatasetRecord, type TransformInputRef, type TransformRecord, type VisualizationRecord, type WorkspaceRecord } from '../shared/records'
import { featureTable, type DataRecord } from '../lib/data/connectors'
import { parseCsv } from '../lib/data/csv'
import { fetchArcGISLayer, importJSON } from '../lib/arcgis'
import { isSupportedBinding, type GeometryBinding } from '../lib/dataset/binding'
import { inferColumns, isGeometryColumn, type ColumnInfo } from '../lib/dataset/columns'
import { newId } from '../lib/dataset/dataset'
import { bindingInfo, findIndex, groupDataset, queryValues, type FindIndex, type Grouped } from '../lib/dataset/query'
import { profileRows } from '../lib/dataset/profile'
import { createSqlRunner, type SqlEngine, type SqlInput } from './sql'

export interface ServerEnv {
  /** A built-in table's rows (CSVs shipped with the app, boundary polygons, demo data). */
  readBuiltin(table: string, baseUrl: string): Promise<DataRecord[]>
  fetchImpl?: typeof fetch
  /** Opens the SQL engine (DuckDB) on first use. Without one, transforms are unsupported. */
  sql?: () => Promise<SqlEngine>
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

type Handlers = { [K in RequestType]: (p: Payload<K>) => Promise<Response<K>> }

export function createServer(db: Database, env: ServerEnv) {
  let baseUrl = '/'
  let userId: string | null = null
  const now = () => new Date().toISOString()

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
          version: `${ds.id}|${ds.updatedAt}`,
          columns: ds.columns,
          rows: async () => (await db.readRows(ds.table)) ?? fail('not_found', `Dataset "${ds.name}" has no data table`),
        }
      }),
    )
  }
  async function runSql(query: string, inputs: TransformInputRef[], limit?: number) {
    if (!sql) fail('unsupported', 'SQL transforms are not available here')
    const tables = await sqlInputs(inputs)
    try {
      return await sql!.run(query, tables, limit)
    } catch (e) {
      // SQL mistakes (and DuckDB's own messages) come back as readable errors.
      return fail('invalid', (e as Error).message)
    }
  }

  async function dataset(id: string): Promise<DatasetRecord> {
    return (await db.get('datasets', id)) ?? fail('not_found', `No dataset "${id}"`)
  }

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
        const b = builtinTable(source.table) ?? fail('not_found', `No built-in table "${source.table}"`)
        return { rows: await env.readBuiltin(b.table, baseUrl), origin: `Built-in · ${b.table}`, name: b.label, description: b.description, extensions: { builtin: b.table, version: b.version } }
      }
    }
  }

  const handlers: Handlers = {
    async init({ baseUrl: url }) {
      baseUrl = url
      const users = await db.list('users')
      if (users.length) userId = users[0].id
      else {
        const t = now()
        userId = newId()
        await db.put('users', { id: userId, name: 'Local user', createdAt: t, updatedAt: t })
      }
      return { userId }
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
        ...(src.description ? { description: src.description } : {}),
        createdAt: t,
        updatedAt: t,
        ...(src.extensions ? { extensions: src.extensions } : {}),
      }
      await db.writeRows(record.table, rows)
      await db.put('datasets', record)
      return { datasetId: id }
    },

    async updateDataset({ id, name, description, extensions }) {
      const ds = await dataset(id)
      if (name !== undefined && !name.trim()) fail('invalid', 'A dataset needs a name')
      await db.put('datasets', {
        ...ds,
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(extensions !== undefined ? { extensions: { ...ds.extensions, ...extensions } } : {}),
        updatedAt: now(),
      })
      return { datasetId: id }
    },

    async deleteDataset({ id }) {
      const ds = await dataset(id)
      await db.dropRows(ds.table)
      await db.delete('datasets', id)
      const gone = new Set<string>()
      for (const v of await db.list('visualizations')) if (v.datasetId === id) (gone.add(v.id), await db.delete('visualizations', v.id))
      for (const w of await db.list('workspaces')) {
        if (!w.config.datasetIds.includes(id)) continue
        const config = { ...w.config, datasetIds: w.config.datasetIds.filter((d) => d !== id), visualizationIds: w.config.visualizationIds.filter((v) => !gone.has(v)) }
        await db.put('workspaces', { ...w, config, updatedAt: now() })
      }
      // A transform that wrote this dataset makes a new one on its next run.
      for (const tr of await db.list('transforms')) if (tr.outputId === id) await db.put('transforms', { ...tr, outputId: undefined, updatedAt: now() })
      forget(id)
      return { datasetId: id }
    },

    async previewTransform({ sql: query, inputs, limit }) {
      return runSql(query, inputs, limit ?? 20)
    },

    async runTransform({ transform }) {
      if (!transform.name.trim()) fail('invalid', 'A transform needs a name')
      const out = await runSql(transform.sql, transform.inputs)
      const t = now()
      const existing = transform.outputId ? await db.get('datasets', transform.outputId) : undefined
      const id = existing?.id ?? newId()
      const record: DatasetRecord = {
        ...(existing ?? { id, table: dataTableName(id), origin: `Transform · ${transform.name.trim()}`, name: transform.name.trim(), createdAt: t }),
        columns: out.columns,
        rowCount: out.rows.length,
        profile: profileRows(out.rows, out.columns),
        updatedAt: t,
      }
      await db.writeRows(record.table, out.rows)
      await db.put('datasets', record)
      forget(id)
      // A saved transform remembers where its output went.
      const saved = await db.get('transforms', transform.id)
      if (saved && saved.outputId !== id) await db.put('transforms', { ...saved, outputId: id, updatedAt: t })
      return { datasetId: id, rowCount: out.rows.length, created: !existing }
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
      for (const d of config.datasetIds) await dataset(d)
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
          sql: tr.sql,
          inputs: tr.inputs.map((i) => ({ datasetId: i.datasetId, alias: i.alias })),
          ...(tr.outputId ? { outputId: tr.outputId } : {}),
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
        ownerId: existing?.ownerId ?? userId ?? fail('invalid', 'Call init first'),
        config: { datasetIds: [...config.datasetIds], visualizationIds: visualizations.map((v) => v.id), transformIds: transforms.map((x) => x.id) },
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
    async handle<K extends RequestType>(type: K, payload: Payload<K>): Promise<ApiResult<Response<K>>> {
      const h = handlers[type] as ((p: Payload<K>) => Promise<Response<K>>) | undefined
      if (!h) return { ok: false, error: { code: 'unsupported', message: `Unknown request "${String(type)}"` } }
      try {
        return { ok: true, data: await h(payload) }
      } catch (e) {
        return { ok: false, error: e instanceof Failure ? { code: e.code, message: e.message } : { code: 'failed', message: (e as Error).message ?? String(e) } }
      }
    },
  }
}
export type Server = ReturnType<typeof createServer>

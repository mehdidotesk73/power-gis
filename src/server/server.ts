// The server: every request that changes the database or does heavy work.
// It writes the database and answers with pointers (ids) or small results.
// Runs in a Web Worker today (worker.ts); the handlers don't know that, so
// they can move behind HTTP later. Errors come back as readable results,
// never as throws.

import type { ApiError, ApiResult, Payload, RequestType, Response, UploadSource } from '../shared/api'
import { BUILTIN_TABLES } from '../shared/builtins'
import type { Database } from '../shared/database'
import { dataTableName, type DatasetRecord, type VisualizationRecord, type WorkspaceRecord } from '../shared/records'
import { featureTable, type DataRecord } from '../lib/data/connectors'
import { parseCsv } from '../lib/data/csv'
import { fetchArcGISLayer, importJSON } from '../lib/arcgis'
import type { BoundaryFeature, BoundaryId, GeometryBinding } from '../lib/dataset/binding'
import { inferColumns, isGeometryColumn, type ColumnInfo } from '../lib/dataset/columns'
import { newId } from '../lib/dataset/dataset'
import { bindingInfo, groupDataset, queryValues, type Grouped } from '../lib/dataset/query'

export interface ServerEnv {
  loadBoundaries(id: BoundaryId): Promise<Map<string, BoundaryFeature>>
  /** A built-in table's rows (already prepared, e.g. ownership flags added). */
  readBuiltin(table: string, baseUrl: string): Promise<DataRecord[]>
  fetchImpl?: typeof fetch
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
  const groupedCache = new Map<string, Promise<{ g: Grouped; columns: ColumnInfo[] }>>()
  const forget = (datasetId: string) => {
    for (const k of groupedCache.keys()) if (k.startsWith(`${datasetId}|`)) groupedCache.delete(k)
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
        const cols = ds.columns.map((c) => c.name)
        if (!cols.includes(binding.column)) fail('invalid', `Dataset "${ds.name}" has no column "${binding.column}"`)
        const type = ds.columns.find((c) => c.name === binding.column)!.type
        if (binding.kind === 'geometry' && !isGeometryColumn(type)) fail('invalid', `"${binding.column}" is a ${type} column, not a geometry column`)
        const rows = (await db.readRows(ds.table)) ?? fail('not_found', `Dataset "${ds.name}" has no data table`)
        const boundaries = binding.kind === 'boundary' ? await env.loadBoundaries(binding.boundary) : undefined
        return { g: groupDataset(rows, ds.columns, binding, boundaries), columns: ds.columns }
      })()
      p.catch(() => groupedCache.delete(key))
      groupedCache.set(key, p)
    }
    return p
  }

  async function readSource(source: UploadSource): Promise<{ rows: DataRecord[]; origin: string; name: string; extensions?: Record<string, unknown> }> {
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
        const b = BUILTIN_TABLES.find((t) => t.table === source.table) ?? fail('not_found', `No built-in table "${source.table}"`)
        return { rows: await env.readBuiltin(b.table, baseUrl), origin: `Built-in · ${b.table}.csv`, name: b.label, extensions: b.extensions }
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
        origin: src.origin,
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
        const config = { datasetIds: w.config.datasetIds.filter((d) => d !== id), visualizationIds: w.config.visualizationIds.filter((v) => !gone.has(v)) }
        await db.put('workspaces', { ...w, config, updatedAt: now() })
      }
      forget(id)
      return { datasetId: id }
    },

    async describeBinding({ datasetId, binding }) {
      const { g, columns } = await grouped(datasetId, binding)
      return bindingInfo(g, columns, binding)
    },

    async queryVisualization({ datasetId, binding, column, aggregation }) {
      const { g, columns } = await grouped(datasetId, binding)
      if (column !== '__rows' && !columns.some((c) => c.name === column)) fail('invalid', `Dataset has no column "${column}"`)
      return queryValues(g, columns, column, aggregation, binding.kind !== 'boundary')
    },

    async featureRows({ datasetId, binding, key }) {
      const { g } = await grouped(datasetId, binding)
      return g.groups.find((x) => x.key === key)?.rows ?? []
    },

    async saveWorkspace({ id, name, config, visualizations }) {
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
      const record: WorkspaceRecord = {
        id: existing?.id ?? newId(),
        name: name.trim(),
        ownerId: existing?.ownerId ?? userId ?? fail('invalid', 'Call init first'),
        config: { datasetIds: [...config.datasetIds], visualizationIds: visualizations.map((v) => v.id) },
        createdAt: existing?.createdAt ?? t,
        updatedAt: t,
      }
      await db.put('workspaces', record)
      return { workspaceId: record.id }
    },

    async deleteWorkspace({ id }) {
      const w = (await db.get('workspaces', id)) ?? fail('not_found', `No workspace "${id}"`)
      for (const v of w.config.visualizationIds) await db.delete('visualizations', v)
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

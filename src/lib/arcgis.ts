// ArcGIS interop: our LayerData ⇄ Esri FeatureSet JSON, GeoJSON and CSV, plus
// reading a layer straight from an ArcGIS FeatureServer/MapServer REST URL.
//
// Type mapping (our field type → esriFieldType):
//   int → Integer, double → Double, string → String, datetime → Date (epoch ms),
//   boolean → SmallInteger (0/1; Esri has no boolean),
//   list / dict / struct → String holding JSON.
//   vector → two Double fields, <name>_u (east) and <name>_v (north) — Esri has
//   no vector type, and u/v fields are what its vector renderers take.
// The full schema rides along under SCHEMA_KEY, so a round trip through our own
// exports restores the composite types exactly; ArcGIS ignores the extra key.

import { arcgisToGeoJSON, geojsonToArcGIS } from '@terraformer/arcgis'
import type { FeatureCollection, Geometry } from 'geojson'
import {
  geometryKindOf,
  parseVector,
  inferFields,
  isPrimitive,
  type FieldDef,
  type FieldType,
  type GeometryKind,
  type LayerData,
  type LayerFeature,
} from './schema'

export const SCHEMA_KEY = 'x-powergis'

export type EsriFieldType =
  | 'esriFieldTypeOID'
  | 'esriFieldTypeSmallInteger'
  | 'esriFieldTypeInteger'
  | 'esriFieldTypeBigInteger'
  | 'esriFieldTypeSingle'
  | 'esriFieldTypeDouble'
  | 'esriFieldTypeString'
  | 'esriFieldTypeDate'
  | 'esriFieldTypeDateOnly'
  | 'esriFieldTypeTimestampOffset'
  | 'esriFieldTypeGUID'
  | 'esriFieldTypeGlobalID'

export type EsriGeometryType = 'esriGeometryPoint' | 'esriGeometryMultipoint' | 'esriGeometryPolyline' | 'esriGeometryPolygon'

export interface EsriField {
  name: string
  type: EsriFieldType | string
  alias?: string
  length?: number
}

export interface EsriFeatureSet {
  objectIdFieldName?: string
  geometryType?: EsriGeometryType | string
  spatialReference?: { wkid?: number; latestWkid?: number }
  fields?: EsriField[]
  features: { attributes: Record<string, unknown>; geometry?: Record<string, unknown> | null }[]
  [SCHEMA_KEY]?: SchemaSidecar
}

interface SchemaSidecar {
  id: string
  name: string
  idField: string
  titleField?: string
  geometry: GeometryKind
  fields: FieldDef[]
  source?: LayerData['source']
}

const OID = 'OBJECTID'

// ── type mapping ───────────────────────────────────────────────────────────

export function toEsriFieldType(t: FieldType): EsriFieldType {
  switch (t) {
    case 'int':
      return 'esriFieldTypeInteger'
    case 'double':
      return 'esriFieldTypeDouble'
    case 'datetime':
      return 'esriFieldTypeDate'
    case 'boolean':
      return 'esriFieldTypeSmallInteger'
    default:
      return 'esriFieldTypeString'
  }
}

export function fromEsriFieldType(t: string): FieldType {
  switch (t) {
    case 'esriFieldTypeOID':
    case 'esriFieldTypeSmallInteger':
    case 'esriFieldTypeInteger':
    case 'esriFieldTypeBigInteger':
      return 'int'
    case 'esriFieldTypeSingle':
    case 'esriFieldTypeDouble':
      return 'double'
    case 'esriFieldTypeDate':
    case 'esriFieldTypeDateOnly':
    case 'esriFieldTypeTimestampOffset':
      return 'datetime'
    default:
      return 'string'
  }
}

export function toEsriGeometryType(g: GeometryKind): EsriGeometryType {
  return g === 'point' ? 'esriGeometryPoint' : g === 'polyline' ? 'esriGeometryPolyline' : 'esriGeometryPolygon'
}

export function fromEsriGeometryType(g: string | undefined): GeometryKind | null {
  if (g === 'esriGeometryPoint' || g === 'esriGeometryMultipoint') return 'point'
  if (g === 'esriGeometryPolyline') return 'polyline'
  if (g === 'esriGeometryPolygon') return 'region'
  return null
}

/** Esri field names: start with a letter, letters/digits/underscore, ≤ 64 chars. */
export function esriFieldName(name: string): string {
  let n = name.replace(/[^A-Za-z0-9_]/g, '_')
  if (!/^[A-Za-z]/.test(n)) n = 'f_' + n
  return n.slice(0, 64)
}

/** One output column: a field, or one component of a vector field. */
interface FlatColumn {
  name: string
  field: FieldDef
  part?: 'u' | 'v'
}

/** Fields as flat columns, vectors split into their u/v components. */
function flatColumns(fields: FieldDef[]): FlatColumn[] {
  return fields.flatMap((f) =>
    f.type === 'vector'
      ? (['u', 'v'] as const).map((part) => ({ name: `${f.name}_${part}`, field: f, part }))
      : [{ name: f.name, field: f }],
  )
}

function flatValue(c: FlatColumn, props: Record<string, unknown> | null | undefined): unknown {
  const v = props?.[c.field.name]
  if (!c.part) return v
  const vec = parseVector(v)
  return vec ? vec[c.part] : null
}

/** Rebuild vector properties from <name>_u / <name>_v columns (in place). */
function joinVectors(props: Record<string, unknown>, fields: FieldDef[]) {
  for (const f of fields) {
    if (f.type !== 'vector' || props[f.name] != null) continue
    const u = props[`${f.name}_u`]
    const v = props[`${f.name}_v`]
    props[f.name] = typeof u === 'number' && typeof v === 'number' ? { u, v } : null
    delete props[`${f.name}_u`]
    delete props[`${f.name}_v`]
  }
}

/** A property value as an Esri attribute. */
export function toEsriValue(v: unknown, t: FieldType): unknown {
  if (v === null || v === undefined) return null
  if (!isPrimitive(t) || t === 'vector') return JSON.stringify(v)
  if (t === 'datetime') {
    const ms = v instanceof Date ? v.getTime() : Date.parse(String(v))
    return Number.isFinite(ms) ? ms : null
  }
  if (t === 'boolean') return v ? 1 : 0
  return v
}

/** An Esri attribute back as a property value of type t. */
export function fromEsriValue(v: unknown, t: FieldType): unknown {
  if (v === null || v === undefined) return null
  if (!isPrimitive(t)) {
    if (typeof v !== 'string') return v
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }
  if (t === 'datetime') {
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (t === 'boolean') return v === 1 || v === true || v === '1' || v === 'true'
  if (t === 'vector') return parseVector(v)
  return v
}

function sidecar(layer: LayerData): SchemaSidecar {
  const { id, name, idField, titleField, geometry, fields, source } = layer
  return { id, name, idField, titleField, geometry, fields, source }
}

// ── export ─────────────────────────────────────────────────────────────────

export function toEsriFeatureSet(layer: LayerData): EsriFeatureSet {
  const cols = flatColumns(layer.fields)
  const names = cols.map((c) => esriFieldName(c.name))
  return {
    objectIdFieldName: OID,
    geometryType: toEsriGeometryType(layer.geometry),
    spatialReference: { wkid: 4326 },
    fields: [
      { name: OID, type: 'esriFieldTypeOID', alias: OID },
      ...cols.map((c, i) => {
        if (c.part) return { name: names[i], type: 'esriFieldTypeDouble', alias: `${c.field.alias ?? c.field.name} (${c.part === 'u' ? 'east' : 'north'})` }
        const f = c.field
        return {
          name: names[i],
          type: toEsriFieldType(f.type),
          alias: f.alias ?? f.name,
          ...(toEsriFieldType(f.type) === 'esriFieldTypeString' ? { length: isPrimitive(f.type) ? 255 : 65535 } : {}),
        }
      }),
    ],
    features: layer.features.map((feat, i) => {
      const attributes: Record<string, unknown> = { [OID]: i + 1 }
      cols.forEach((c, k) => {
        const v = flatValue(c, feat.properties)
        attributes[names[k]] = c.part ? v : toEsriValue(v, c.field.type)
      })
      const geometry = feat.geometry ? { ...geojsonToArcGIS(feat.geometry), spatialReference: { wkid: 4326 } } : null
      return { attributes, geometry }
    }),
    [SCHEMA_KEY]: sidecar(layer),
  }
}

/**
 * GeoJSON FeatureCollection. With `flatten`, composite values become JSON
 * strings — what ArcGIS Online's GeoJSON import needs, since it drops nested
 * objects.
 */
export function toGeoJSON(layer: LayerData, flatten = false): FeatureCollection & { [SCHEMA_KEY]: SchemaSidecar } {
  const features = !flatten
    ? layer.features
    : layer.features.map((f) => ({
        ...f,
        properties: Object.fromEntries(
          flatColumns(layer.fields).map((c) => {
            const v = flatValue(c, f.properties)
            return [c.name, !isPrimitive(c.field.type) && v != null ? JSON.stringify(v) : (v ?? null)]
          }),
        ),
      }))
  return { type: 'FeatureCollection', features, [SCHEMA_KEY]: sidecar(layer) }
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Attribute table as CSV (no geometry) — joinable in ArcGIS on the id field. */
export function toCSV(layer: LayerData): string {
  const cols = flatColumns(layer.fields)
  const header = cols.map((c) => csvCell(c.name)).join(',')
  const rows = layer.features.map((feat) => cols.map((c) => csvCell(flatValue(c, feat.properties))).join(','))
  return [header, ...rows].join('\n') + '\n'
}

// ── import ─────────────────────────────────────────────────────────────────

function finishLayer(
  features: LayerFeature[],
  meta: Partial<SchemaSidecar> & { name: string },
  fields?: FieldDef[],
): LayerData {
  const geometry = meta.geometry ?? features.map((f) => geometryKindOf(f.geometry)).find((g) => g) ?? 'region'
  const schema = fields ?? inferFields(features)
  let idField = meta.idField
  if (!idField || !schema.some((f) => f.name === idField)) {
    idField = '_id'
    features.forEach((f, i) => (f.properties = { ...f.properties, _id: String(f.id ?? i + 1) }))
    schema.unshift({ name: '_id', type: 'string', alias: 'ID' })
  }
  return {
    id: meta.id ?? meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: meta.name,
    geometry,
    idField,
    titleField: meta.titleField,
    fields: schema,
    features,
    source: meta.source,
  }
}

export function fromGeoJSON(fc: FeatureCollection & { [SCHEMA_KEY]?: SchemaSidecar }, name = 'Imported layer'): LayerData {
  const meta = fc[SCHEMA_KEY]
  const fields = meta?.fields
  const features = fc.features.map((f) => {
    const props = { ...(f.properties ?? {}) }
    if (fields) {
      joinVectors(props, fields)
      for (const fd of fields) props[fd.name] = fromEsriValue(props[fd.name], fd.type)
    }
    return { ...f, properties: props } as LayerFeature
  })
  return finishLayer(features, { name, ...meta }, fields ? [...fields] : undefined)
}

export function fromEsriFeatureSet(fs: EsriFeatureSet, name = 'Imported layer'): LayerData {
  const meta = fs[SCHEMA_KEY]
  const esriFields = fs.fields ?? []
  // Our own sidecar wins; otherwise map Esri types (and keep Esri names).
  const fields: FieldDef[] =
    meta?.fields ??
    esriFields.map((f) => ({ name: f.name, type: fromEsriFieldType(String(f.type)), alias: f.alias !== f.name ? f.alias : undefined }))
  const byEsriName = new Map(fields.map((f) => [esriFieldName(f.name), f]))
  const parts = new Map(flatColumns(fields).filter((c) => c.part).map((c) => [esriFieldName(c.name), c.name]))
  const features: LayerFeature[] = fs.features.map((ef) => {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(ef.attributes ?? {})) {
      const fd = byEsriName.get(k) ?? fields.find((f) => f.name === k)
      if (fd) props[fd.name] = fromEsriValue(v, fd.type)
      else if (parts.has(k)) props[parts.get(k)!] = v
      else if (!meta) props[k] = v
    }
    joinVectors(props, fields)
    const geometry = ef.geometry ? (arcgisToGeoJSON(ef.geometry) as unknown as Geometry) : null
    return { type: 'Feature', geometry: geometry as Geometry, properties: props }
  })
  const idField = meta?.idField ?? fs.objectIdFieldName
  return finishLayer(features, { name, ...meta, idField, geometry: meta?.geometry ?? fromEsriGeometryType(fs.geometryType) ?? undefined }, fields)
}

/** Detect the format of a parsed JSON file and import it. */
export function importJSON(json: unknown, name?: string): LayerData {
  const o = json as Record<string, unknown>
  if (o?.type === 'FeatureCollection') return fromGeoJSON(o as unknown as FeatureCollection, name)
  if (Array.isArray(o?.features)) return fromEsriFeatureSet(o as unknown as EsriFeatureSet, name)
  throw new Error('Not a GeoJSON FeatureCollection or an Esri FeatureSet')
}

// ── ArcGIS REST ────────────────────────────────────────────────────────────

/**
 * Load a FeatureServer/MapServer layer, e.g.
 *   https://services.arcgis.com/…/FeatureServer/0
 * Pages through /query in WGS84 and keeps the service's field types.
 */
export async function fetchArcGISLayer(
  url: string,
  opts: { where?: string; maxFeatures?: number; fetchImpl?: typeof fetch } = {},
): Promise<LayerData> {
  const base = url.replace(/\/query\/?$/, '').replace(/\/+$/, '')
  const get = opts.fetchImpl ?? fetch
  const metaRes = await get(`${base}?f=json`)
  const meta = (await metaRes.json()) as {
    name?: string
    fields?: EsriField[]
    geometryType?: string
    objectIdField?: string
    maxRecordCount?: number
    error?: { message?: string }
  }
  if (meta.error) throw new Error(meta.error.message ?? 'ArcGIS service error')
  const pageSize = Math.min(meta.maxRecordCount ?? 1000, 2000)
  const max = opts.maxFeatures ?? 20000
  const all: EsriFeatureSet['features'] = []
  for (let offset = 0; offset < max; offset += pageSize) {
    const q = new URLSearchParams({
      where: opts.where ?? '1=1',
      outFields: '*',
      outSR: '4326',
      f: 'json',
      resultOffset: String(offset),
      resultRecordCount: String(Math.min(pageSize, max - offset)),
    })
    const page = (await (await get(`${base}/query?${q}`)).json()) as EsriFeatureSet & { exceededTransferLimit?: boolean; error?: { message?: string } }
    if (page.error) throw new Error(page.error.message ?? 'ArcGIS query error')
    all.push(...page.features)
    if (!page.exceededTransferLimit || page.features.length === 0) break
  }
  return fromEsriFeatureSet(
    { objectIdFieldName: meta.objectIdField, geometryType: meta.geometryType, fields: meta.fields, features: all },
    meta.name ?? 'ArcGIS layer',
  )
}

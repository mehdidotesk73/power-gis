import { describe, expect, it } from 'vitest'
import { esriFieldName, fromEsriFeatureSet, fromGeoJSON, importJSON, toCSV, toEsriFeatureSet, toGeoJSON } from './arcgis'
import { listOf, structOf, type LayerData } from './schema'

const layer: LayerData = {
  id: 'test',
  name: 'Test',
  geometry: 'region',
  idField: 'fips',
  titleField: 'name',
  fields: [
    { name: 'fips', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'count', type: 'int' },
    { name: 'share', type: 'double' },
    { name: 'active', type: 'boolean' },
    { name: 'updated', type: 'datetime' },
    { name: 'tags', type: listOf('string') },
    { name: 'owners', type: listOf(structOf([{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }])) },
  ],
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      properties: {
        fips: '01001',
        name: 'Alpha, "the first"',
        count: 3,
        share: 0.25,
        active: true,
        updated: '2025-01-01T00:00:00.000Z',
        tags: ['a', 'b'],
        owners: [{ id: 7, name: 'Co-op' }],
      },
    },
  ],
}

describe('Esri FeatureSet', () => {
  it('maps field types to esriFieldTypes', () => {
    const fs = toEsriFeatureSet(layer)
    const types = Object.fromEntries(fs.fields!.map((f) => [f.name, f.type]))
    expect(types).toMatchObject({
      OBJECTID: 'esriFieldTypeOID',
      count: 'esriFieldTypeInteger',
      share: 'esriFieldTypeDouble',
      active: 'esriFieldTypeSmallInteger',
      updated: 'esriFieldTypeDate',
      tags: 'esriFieldTypeString',
    })
    expect(fs.geometryType).toBe('esriGeometryPolygon')
    const a = fs.features[0].attributes
    expect(a.active).toBe(1)
    expect(a.updated).toBe(Date.UTC(2025, 0, 1))
    expect(a.owners).toBe('[{"id":7,"name":"Co-op"}]')
    expect(fs.features[0].geometry).toHaveProperty('rings')
  })

  it('round-trips types and values exactly through our own sidecar', () => {
    const back = fromEsriFeatureSet(JSON.parse(JSON.stringify(toEsriFeatureSet(layer))))
    expect(back.fields).toEqual(layer.fields)
    expect(back.idField).toBe('fips')
    expect(back.features[0].properties).toEqual(layer.features[0].properties)
    expect(back.features[0].geometry.type).toBe('Polygon')
  })

  it('reads a plain ArcGIS FeatureSet with no sidecar', () => {
    const back = fromEsriFeatureSet({
      objectIdFieldName: 'FID',
      geometryType: 'esriGeometryPoint',
      fields: [
        { name: 'FID', type: 'esriFieldTypeOID' },
        { name: 'Cap_MW', type: 'esriFieldTypeDouble', alias: 'Capacity' },
        { name: 'Online', type: 'esriFieldTypeDate' },
      ],
      features: [{ attributes: { FID: 1, Cap_MW: 12.5, Online: 0 }, geometry: { x: -90, y: 35 } }],
    })
    expect(back.geometry).toBe('point')
    expect(back.idField).toBe('FID')
    expect(back.fields.find((f) => f.name === 'Cap_MW')).toMatchObject({ type: 'double', alias: 'Capacity' })
    expect(back.features[0].properties.Online).toBe('1970-01-01T00:00:00.000Z')
    expect(back.features[0].geometry).toEqual({ type: 'Point', coordinates: [-90, 35] })
  })
})

describe('GeoJSON / CSV', () => {
  it('round-trips GeoJSON, and flattens composites for ArcGIS Online', () => {
    expect(fromGeoJSON(JSON.parse(JSON.stringify(toGeoJSON(layer)))).features[0].properties).toEqual(layer.features[0].properties)
    const flat = toGeoJSON(layer, true)
    expect(flat.features[0].properties!.tags).toBe('["a","b"]')
    expect(importJSON(JSON.parse(JSON.stringify(flat))).features[0].properties.tags).toEqual(['a', 'b'])
  })

  it('infers a schema and an id for foreign GeoJSON', () => {
    const l = fromGeoJSON({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { kv: 345, name: 'Line' } }],
    })
    expect(l.geometry).toBe('polyline')
    expect(l.idField).toBe('_id')
    expect(l.fields.find((f) => f.name === 'kv')?.type).toBe('int')
  })

  it('quotes CSV cells', () => {
    const csv = toCSV(layer)
    expect(csv.split('\n')[0]).toBe('fips,name,count,share,active,updated,tags,owners')
    expect(csv).toContain('"Alpha, ""the first"""')
  })

  it('sanitizes field names for Esri', () => {
    expect(esriFieldName('2024 sales (MWh)')).toBe('f_2024_sales__MWh_')
  })
})

describe('vector fields', () => {
  const vecLayer: LayerData = {
    id: 'v',
    name: 'Vectors',
    geometry: 'point',
    idField: 'id',
    fields: [
      { name: 'id', type: 'string' },
      { name: 'wind', type: 'vector', alias: 'Wind' },
    ],
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 'a', wind: { u: 3, v: -1 } } }],
  }

  it('exports a vector as two Double fields and restores it on import', () => {
    const fs = toEsriFeatureSet(vecLayer)
    expect(fs.fields!.map((f) => [f.name, f.type])).toEqual([
      ['OBJECTID', 'esriFieldTypeOID'],
      ['id', 'esriFieldTypeString'],
      ['wind_u', 'esriFieldTypeDouble'],
      ['wind_v', 'esriFieldTypeDouble'],
    ])
    expect(fs.features[0].attributes).toMatchObject({ wind_u: 3, wind_v: -1 })
    expect(fromEsriFeatureSet(JSON.parse(JSON.stringify(fs))).features[0].properties.wind).toEqual({ u: 3, v: -1 })
  })

  it('splits vectors in CSV and flattened GeoJSON, keeps them whole in plain GeoJSON', () => {
    expect(toCSV(vecLayer).split('\n')[0]).toBe('id,wind_u,wind_v')
    expect(toGeoJSON(vecLayer, true).features[0].properties).toEqual({ id: 'a', wind_u: 3, wind_v: -1 })
    expect(toGeoJSON(vecLayer).features[0].properties!.wind).toEqual({ u: 3, v: -1 })
    expect(importJSON(JSON.parse(JSON.stringify(toGeoJSON(vecLayer, true)))).features[0].properties.wind).toEqual({ u: 3, v: -1 })
  })
})

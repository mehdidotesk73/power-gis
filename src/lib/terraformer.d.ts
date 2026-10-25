declare module '@terraformer/arcgis' {
  import type { Geometry } from 'geojson'
  export function geojsonToArcGIS(geojson: Geometry, idAttribute?: string): Record<string, unknown>
  export function arcgisToGeoJSON(arcgis: Record<string, unknown>, idAttribute?: string): { type: string } & Record<string, unknown>
}

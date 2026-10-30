// Upload's other kinds: GeoJSON files and an ArcGIS layer's URL (CSV files are in the pipeline tests).
// The ArcGIS service is faked (its layer description, then one page of features), as the app reads it.
import { expect, test, type Page } from '@playwright/test'
import { card, closeDevices, device, explore, FIXTURES, listPanel } from './helpers'

test.afterEach(closeDevices)

async function openUpload(page: Page) {
  await listPanel(page, 'Datasets')
  const panel = page.locator('details', { has: page.locator('summary', { hasText: /^Datasets$/ }) })
  await panel.getByRole('button', { name: 'Dataset', exact: true }).click()
  await panel.getByTestId('add.source.upload').click()
  return panel
}

test('a GeoJSON file becomes a dataset with a point geometry column', async ({ browser }) => {
  const page = await device(browser)
  const panel = await openUpload(page)
  await panel.getByTestId('add.source.json').check()
  await panel.getByTestId('add.json-input').setInputFiles(`${FIXTURES}plants.geojson`)
  await expect(card(page, 'dataset', 'plants')).toContainText('3 rows')
  // Its values, and the geometry as a point column (GeoJSON text in SQL), in one query.
  expect(await explore(page, 'plants', "SELECT plant, mw, geometry LIKE '%Point%' AS is_point FROM plants ORDER BY mw")).toEqual([
    ['Lake Shore', '80', 'true'],
    ['North Ridge', '120.5', 'true'],
    ['Desert Sun', '250', 'true'],
  ])
})

test('an ArcGIS layer URL becomes a dataset (its fields, its points)', async ({ browser }) => {
  const page = await device(browser)
  const layer = 'https://services.example.com/arcgis/rest/services/Substations/FeatureServer/0'
  const asked: string[] = []
  await page.context().route(`${layer}**`, async (route) => {
    const url = new URL(route.request().url())
    asked.push(url.pathname.endsWith('/query') ? 'query' : 'layer')
    const json = (body: object) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
    if (!url.pathname.endsWith('/query'))
      return json({
        name: 'Substations',
        geometryType: 'esriGeometryPoint',
        objectIdField: 'OBJECTID',
        maxRecordCount: 1000,
        fields: [
          { name: 'OBJECTID', type: 'esriFieldTypeOID' },
          { name: 'NAME', type: 'esriFieldTypeString' },
          { name: 'KV', type: 'esriFieldTypeDouble' },
        ],
      })
    return json({
      geometryType: 'esriGeometryPoint',
      features: [
        { attributes: { OBJECTID: 1, NAME: 'Elm Street', KV: 138 }, geometry: { x: -95.4, y: 29.8 } },
        { attributes: { OBJECTID: 2, NAME: 'Harbor', KV: 345 }, geometry: { x: -118.2, y: 33.7 } },
      ],
      exceededTransferLimit: false,
    })
  })
  const panel = await openUpload(page)
  await panel.getByTestId('add.source.arcgis').check()
  await panel.getByTestId('add.arcgis-url').fill(layer)
  await panel.getByTestId('add.arcgis-add').click()
  await expect(card(page, 'dataset', 'Substations')).toContainText('2 rows')
  expect(asked).toEqual(['layer', 'query'])
  expect(await explore(page, 'Substations', 'SELECT NAME, KV FROM Substations ORDER BY KV')).toEqual([
    ['Elm Street', '138'],
    ['Harbor', '345'],
  ])
})

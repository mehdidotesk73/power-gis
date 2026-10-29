# PowerGIS

Power-sector data on a map. PowerGIS displays GeoJSON features (points, polylines and regions) with
typed properties, and visualizes data on them through reusable map widgets:

- **Scalars**: color (single, colormap or categorical), transparency, and fill patterns
- **Vectors**: arrows with direction, size, color and transparency
- **Panels**: a hover tooltip, and a click-to-open feature panel with the rows behind a feature
- **Transforms**: DuckDB SQL over datasets (joins, points from lat/lon, vectors)
- **ArcGIS interop**: Esri JSON, GeoJSON and CSV import/export, plus loading FeatureServer layers

**Default map:** a county socioeconomic score (income, education, health insurance, housing
affordability) and area-weighted state averages, from six Census ACS county tables built into the app
(`public/data/county_*.csv`) and the built-in county and state shapes, by ten SQL transforms in the
default workspace file (`public/data/default.powergis.json`). The EIA-861 utility tables
(`scripts/build_utility_counties.py`) remain built-ins.

Built with Vue 3 + TypeScript + Vite (PWA) and MapLibre GL.

## Links

- Live site: https://powergis.netlify.app
- Previews: `deploy-preview-<n>--powergis.netlify.app` for every PR

## Local development

```bash
npm install
npm run dev     # dev server at http://localhost:5173
npm run build   # type-check + bundle
npm test        # unit tests (vitest)
```

Rebuild the data (needs Python with `pandas` and `pyarrow`):

```bash
python scripts/build_utility_counties.py [year]
```

## Docs

- [CLAUDE.md](./CLAUDE.md): workflow and conventions
- [docs/system-design.md](./docs/system-design.md): architecture
- [docs/concepts/overview.md](./docs/concepts/overview.md): user help (also shown in the app's Help modal)
- [docs/TODO.md](./docs/TODO.md): backlog

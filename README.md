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
and the built-in county and state shapes, by ten SQL transforms. Data and workspace come from a
**default folder** (`defaults/socioeconomic/`); the app ships whichever folder `defaults/active.json`
points at (`defaults/README.md`).

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

## Docs

- [CLAUDE.md](./CLAUDE.md): workflow and conventions
- [docs/system-design.md](./docs/system-design.md): architecture
- [docs/concepts/overview.md](./docs/concepts/overview.md): user help (also shown in the app's Help modal)
- [docs/TODO.md](./docs/TODO.md): backlog

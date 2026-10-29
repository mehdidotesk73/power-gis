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

## How it's built

I lead the product and its design. I set the architecture: the browser-side client / server split;
datasets, transforms and visualizations as separate building blocks; local copies with manual cloud
sync, plus the sharing and access rules; and default folders. I also define the features and
interaction details, and how the AI assistant should work. Claude Code writes the code from that
direction, one pull request per change. I review every preview on physical devices, and use screenshots and logs to communicate bugs, and merge each PR myself.

**Tests.** I set the testing approach: real-database integration tests and two-person, multi-device UI
scenarios on every PR; mock data and a reference pipeline that I built in the app; and expected values
that I sign off on. Claude writes and maintains the test code and the CI setup.

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

Cloud integration and UI tests run against a local Supabase stack (Docker): see
[tests/e2e/README.md](./tests/e2e/README.md).

## Docs

- [CLAUDE.md](./CLAUDE.md): workflow and conventions
- [docs/system-design.md](./docs/system-design.md): architecture
- [docs/concepts/overview.md](./docs/concepts/overview.md): user help (also shown in the app's Help modal)
- [docs/TODO.md](./docs/TODO.md): backlog

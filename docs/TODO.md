# TODO — Project Backlog

Track feature development, improvements, and known issues here. Move completed work to **Done**, queue new ideas under **Next**, and record blockers in **Blocked**.

## Done

- **Scaffold + personalization** — template copied in, docs filled for PowerGIS.
- **Map widgets + first dataset (utilities by county)** — reusable MapLibre widgets
  (`MapView`, `ScalarLayer`, `VectorLayer`, `FeatureTooltip`, `FeaturePanel` + `PropertyValue`,
  `MapLegend`, style editors, `DataExchange`) over a typed layer model (`lib/schema.ts`) with
  declarative styles (`lib/style.ts`: colormap / categorical color, opacity, fill patterns, arrows).
  ArcGIS interop in `lib/arcgis.ts` (Esri JSON, GeoJSON, CSV, FeatureServer fetch). EIA-861 2025
  service territory → `public/data/utility_counties.csv` (2,904 utilities, 11,798 utility-county
  rows, 3,133 counties) via `scripts/build_utility_counties.py`, joined to `us-atlas` counties.

## Next (Current Sprint)

One-time setup — tick these off as they're done:

- [x] Connect Netlify (finish-setup) — required; gives previews AND the production site
      (site: https://powergis.netlify.app)
- [x] Protect `main` (finish-setup) — required; this is what makes changes arrive as PRs with
      preview links, instead of going straight to the live site
- [ ] Review the utilities-by-county map on a phone

## Code

- Real vector dataset (e.g. EIA-930 balancing-authority interchange flows) to replace the demo arrows
- Point and polyline datasets (plants from EIA-860, transmission lines) to exercise those geometries
- Patterns for polylines (dash arrays) and points (symbol overlays)
- Arrow length encoding (currently size scales the whole glyph)
- Per-county customer estimates (EIA reports customers per utility per state only)
- Utility service-territory polygons (HIFLD) as an alternative to county granularity

## Docs

(Documentation gaps, missing help content, outdated instructions)

## UI / UX

(Design improvements, accessibility, mobile issues)

## DevOps / Build

(CI/CD, deployment, build process improvements)

## Known Issues

(Bugs, edge cases, platform-specific quirks)

## Ideas / Backlog (Low Priority)

(Features to explore later, might-nots, "wouldn't it be cool if...")

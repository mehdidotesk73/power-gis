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

### Roadmap (agreed order)

Everything the UI can do must also be a plain, serializable operation with machine-readable
results, because the agent workflow (step 6) drives the same operations as the UI.

1. **Workspace document + operations + on-device persistence** — one serializable workspace
   (datasets, derived datasets, visualizations, tabs); a single operations layer (add dataset,
   add derived dataset, add/reorder visualization, …) used by both UI and agents. Datasets carry
   only **standard metadata** (name, description, created/updated, columns, profile) plus an
   open-ended extension slot for features to attach their own; **sources and usage policy are not
   dataset properties** — they belong to the agent workflow's records (step 6). Saved on the device (localStorage for specs, IndexedDB for tables). Dataset drag-reordering.
2. **DuckDB-WASM + derived datasets + dataset profiles** — DuckDB (lazy-loaded) for SQL; a derived
   dataset is a SQL query over datasets, then bound to geometry like an import (this also covers
   visualizations sourced from several datasets: join, then visualize). A **profile** for every
   dataset (row count, columns/types, nulls, completeness, key coverage) — the metadata agents
   report for approval. SQL errors and profiles returned in agent-readable form.
3. **Normalize the EIA-861 data** — **counties**, **utilities** and a **county ↔ utility join table**
   (and the alternative: a utilities **list-of-counties column** joined by unnest); rebuild today's
   map from a SQL join. Fixes the misleading `counties_in_state` (it's per utility, not per state).
4. **DAG** — connector → dataset → derived dataset → visualization, built from the workspace
   document; later also a live view of agent pipelines (with their source / usage-policy records).
5. **Tabs** — datasets shared; each tab has its own ordered visualizations, map view and DAG.
   **Phones: tabs only.**
6. **Agent workflow** — see below.

**Decided:** DuckDB for SQL · scraped datasets live **on the device** · agents may run only while
the app is open at first · agents run on **Claude Managed Agents** with a thin **Netlify Function**
bridge (holds the Anthropic API key, starts sessions, relays clarifications/approvals/results).
**Postponed:** user login / cloud workspace · split screen.

### Agent workflow (step 6)

- **Orchestrator** — takes a request ("all datacenters and their loads", "temperature");
  asks clarifying questions when ambiguous (e.g. frequency daily/weekly…, aggregate avg/max/min);
  decides which base datasets are needed (e.g. datacenter load + county population + county→state
  map → load-per-capita by state); writes a **scraping request** per base dataset (loose list of
  intended columns), a **transformation plan** and a **visualization plan**, each with
  requirements the previous stage must meet. Spawns one scraper per dataset; assesses each
  scraper's summary against the transformation requirements (approve, or adjust the plan / the
  scraping request — sometimes waiting on several scrapers first); shares what's already found
  so agents don't repeat work. Checks every source's **usage policy** and reports at the end
  whether the data can be shared publicly or is personal-use only. Sources and usage policies live
  in the **workflow's run records** (per request: plans, agent reports, approvals, sources,
  policies), linked to the datasets it produced — not as properties of the datasets themselves. Sends one or several parallel
  transform requests; checks transformer metadata against visualization requirements; sends
  visualization requests; **orders** the returned visualizations; summarizes and asks the user to
  approve or adjust (adjustments restart the cycle with updated instructions). **No agent is
  iterated more than 5 times per cycle** — past that, report exactly what happened.
- **Scraper agent** — searches the web for one dataset; reports a profile (partial vs complete,
  matched / missing columns, row count) and sources; saves and returns the data only after
  approval; its report (part of the run record) lists **all sources** and their usage terms.
- **Transformer agent** — writes SQL (DuckDB) for its transformation request, creates the
  transformed datasets, reports their profiles; saves and returns only after approval.
- **Visualizer agent** — turns visualization requests (strategy + datasets) into visualization
  specs (the step-1 operations) and returns them.
- **Runtime** — Managed Agents sessions (orchestrator + sub-agents, built-in web search/fetch,
  per-session container with DuckDB for transforms, session dollar budgets as a backstop to the
  5-iteration cap); a Netlify Function bridge; datasets returned as files and stored on device;
  a chat panel in the app for clarifications, approvals and the final summary; every step logged
  into the DAG.

### Backlog

- Real vector dataset (e.g. EIA-930 balancing-authority interchange flows) to replace the demo arrows
- Point and polyline datasets (plants from EIA-860, transmission lines) to exercise those geometries
- Patterns for polylines (dash arrays) and points (symbol overlays)
- Arrow length encoding (currently size scales the whole glyph)
- Per-county customer estimates (EIA reports customers per utility per state only)
- Database `DataConnector` (e.g. Supabase) — interface is ready in `src/lib/data/connectors.ts`; needs the
  `add-statefulness` / `add-database` decision first
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

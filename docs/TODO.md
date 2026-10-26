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
- **Workspace document + operations + on-device persistence (roadmap step 1)** — `lib/workspace/`:
  `WorkspaceDoc` (datasets with standard metadata + ordered visualizations) changed only through
  pure ops (`addDataset`, `updateDataset`, `reorderDatasets`, `addVisualization`, …) returning
  agent-readable `{ok, doc} | {ok:false, error}`; saved via `saveWorkspace` to localStorage, imported
  rows to IndexedDB (`indexedDbTableStore`), built-ins re-read; restored on open, **Reset
  workspace**. Datasets can be renamed/described and drag-reordered (`useDragReorder`, shared
  with the visualization list).
- **Client / server boundary + database (roadmap 1b, part 1)** — server in a Web Worker
  (`server/server.ts` `createServer`, `worker.ts`), typed requests (`shared/api.ts`) returning
  `ApiResult`s, client `request()` + read-only `readDb`. IndexedDB database with base tables
  (`users`, `workspaces`, `datasets`, `transforms`, `visualizations`; uuid + name) and one data table
  per dataset. Uploads, dataset edits (rename, describe, vector column), visualization values
  (`queryVisualization`, grouping cached per dataset+binding), feature rows and workspace saves all
  go through the server. Geometry binding moved into visualization settings (`BindingEditor`).
  Workspace config holds pointers only; datasets outlive workspaces (＋ Add dataset → Saved).
- **Explicit Save + draft + workspace files (roadmap 1b, part 2)** — `WorkspaceBar` (name, Save,
  Unsaved changes / Discard, ⋯ menu). Edits are a localStorage draft until Save (`snapshot`,
  `parseDraft`); `.powergis.json` download / load of pointers + settings (`toWorkspaceFile`,
  `parseWorkspaceFile`, `fromWorkspaceFile`: fresh visualization ids, missing datasets reported).
  Reset is now a draft too.
- **Categorical palettes** — `lib/palettes.ts` (`paletteColors`, `manyColors`, `PALETTES`): fixed
  nested 12 / 24 / 60-color palettes (Tableau + CIELAB max-min), `many` (lightness variations) and
  `auto`. Category colors no longer stop at 9 (no `maxCategories`); palette picker + swatch strip in
  the editor; legends with many items in columns. Reusable for charts.
- **Geometry columns** — `point` / `polyline` / `region` column types (GeoJSON, lon/lat; inferred
  from GeoJSON or WKT); visualizations draw a geometry column (lat/lon bindings removed;
  `isSupportedBinding` drops old ones). Geometry comes with the data (nothing derived at upload;
  lat/lon → point and u/v → vector are transforms, step 2). Region-code binding kept as a stopgap
  until boundary datasets + joins.
- **Transforms + profiles (roadmap step 2)** — DuckDB-WASM in the server worker, lazy-loaded
  (`server/duckdb.ts`, `server/sql.ts` `createSqlRunner`; `point(lat, lon)` / `vector(u, v)`
  helpers); `previewTransform` / `runTransform` (output pointer: overwrite or new dataset);
  transforms in the workspace draft + saveWorkspace + files (`TransformSpec`, `addTransform` …);
  `TransformsPanel` (inputs with aliases, SQL, Preview, Run). Dataset profiles
  (`lib/dataset/profile.ts`) stored on every write, shown in the dataset editor. Tests on real
  DuckDB (Node build).
- **Transform inputs + dataset preview** — inputs read "dataset **as** alias"; **Insert** puts the
  alias into the SQL at the cursor; renaming an alias renames it in the SQL; "no such table" errors
  list the usable tables. ▤ on a dataset previews its first 20 rows (read from the database); ⧉
  copies its id. Input datasets are picked in a search box (name with typo tolerance, or id).
  `point(lat, lon)` (was lon, lat). **Find** replaces "Find a utility": any visualization, all data or
  one column, typo-tolerant, server-built index (`findIndex` / `findFeatures`), highlight + zoom.
- **Normalized EIA data + boundary datasets, data-agnostic (roadmap step 3)** — EIA-861 as
  `utilities` (identity) and `utility_counties` (links); built-in `us_counties` / `us_states`
  boundary datasets; the default map is `public/data/default.powergis.json` (built-ins + the
  **Utilities by county** join transform + visualizations). Region-code binding, the county dashboard,
  utility presets and ownership flags deleted; geometry bindings name features by a `label` column.

## Next (Current Sprint)

One-time setup — tick these off as they're done:

- [x] Connect Netlify (finish-setup) — required; gives previews AND the production site
      (site: https://powergis.netlify.app)
- [x] Protect `main` (finish-setup) — required; this is what makes changes arrive as PRs with
      preview links, instead of going straight to the live site
- [ ] Review the utilities-by-county map on a phone (now built from datasets + a join transform)

## Code

### Roadmap (agreed order)

Everything the UI can do must also be a plain, serializable operation with machine-readable
results, because the agent workflow (step 6) drives the same operations as the UI.

1. ~~**Workspace document + operations + on-device persistence**~~ (done, see Done; derived datasets and tabs join the document in steps 2 and 5) — one serializable workspace
   (datasets, derived datasets, visualizations, tabs); a single operations layer (add dataset,
   add derived dataset, add/reorder visualization, …) used by both UI and agents. Datasets carry
   only **standard metadata** (name, description, created/updated, columns, profile) plus an
   open-ended extension slot for features to attach their own; **sources and usage policy are not
   dataset properties** — they belong to the agent workflow's records (step 6). Saved on the device (localStorage for specs, IndexedDB for tables). Dataset drag-reordering.
1b. **Client / server boundary + database** (agreed 2026-10-25; done — see Done) —
   everything is client-side today, but the code is split as if it weren't, so moving to a real
   backend (Supabase) is a refactor, not a rewrite.
   - **Rule:** lasting changes and heavy processing are **server side**. The client sends requests;
     the server writes the database and returns **pointers** (uuids); the client reads the database
     (read-only) by pointer. The client never writes the database directly.
   - **Today's server** runs in a **Web Worker** (`src/server/`), talking only through serializable
     messages; the client calls it through a typed API (`src/client/api.ts`). Database = IndexedDB;
     DuckDB-WASM (step 2) lives in the worker. Later the same API goes over HTTP.
   - **Base tables** (every row: `uuid` id + editable `name`; all readable/writable by everyone for
     now — an access layer goes between users and tables later): `users` (one default local user),
     `workspaces` (id, name, config JSON of pointers + order), `datasets` (registry: id, name, data
     table, columns, row count, standard metadata), `transforms` (id, name, SQL, input dataset ids,
     output dataset id — missing = new output), `visualizations` (id, name, dataset id, settings
     JSON). **Each dataset is its own table** of rows.
   - **Requests:** upload file → new dataset table → dataset id; save workspace / transform /
     visualization → id; **run transform** (new or existing, any time) → output dataset id;
     **query visualization** → one value per feature, computed server side (SQL GROUP BY).
   - **Geometry binding lives in the visualization settings** (datasets are plain tables), so one
     table can be drawn as counties or as points. Boundary polygons stay static client assets; the
     server returns values per feature key (or geometry for lat/lon and shape bindings).
   - **Explicit Save:** edits are a client-side draft (kept locally across reloads, "unsaved
     changes" marker) until **Save** sends the config to the server.
   - **Workspace file** download / load holds the config (pointers) only, never rows — it opens
     wherever the database has those ids (this device today; any device with Supabase).
   - Built-in EIA data is loaded into the database once, as an ordinary dataset.
1c. ~~**Geometry columns**~~ (done, see Done) — visualizations draw real features: a point /
   polyline / region column (lon/lat), from the data or a transform.
2. ~~**DuckDB-WASM + derived datasets + dataset profiles**~~ (done, see Done; key coverage in profiles still open) — DuckDB (lazy-loaded) for SQL; a derived
   dataset is a SQL query over datasets (e.g. lat + lon → point, east + north → vector), whose geometry columns visualizations draw (this also covers
   visualizations sourced from several datasets: join, then visualize). A **profile** for every
   dataset (row count, columns/types, nulls, completeness, key coverage) — the metadata agents
   report for approval. SQL errors and profiles returned in agent-readable form.
3. ~~**Normalize the EIA-861 data + boundary datasets, data-agnostic**~~ (done, see Done) — still
   open: the alternative shape (a utilities **list-of-counties column** joined by unnest) once list
   columns round-trip through transforms.
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

- EIA-861 customers / sales / revenue as a separate built-in (per utility × state)
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

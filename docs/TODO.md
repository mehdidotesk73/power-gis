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
- **Graph view (roadmap step 4, first version)** — List | Graph switch; `lib/workspace/dag.ts`
  (nodes, edges, rows by depth, barycenter order, automatic layout) + `DagView.vue`; tap a node to
  open it under the graph; ＋ Transform (tap inputs) and ＋ Visualization (tap a dataset); transforms
  marked not run yet / needs re-run. Transforms have several outputs (one SQL each, per-output
  Preview, one Run writes all; nothing written if any fails); one writer per dataset.
- **Graph layout + panel UI** — crossing-minimizing DAG layout (virtual points for row-skipping
  arrows, barycenter sweeps + swaps), ↓ / → direction toggle, resizable desktop side panel, ⤢ pop-out
  of the workspace panels into a modal (open item beside the graph), Search card ("Search in [viz] in
  [column]"), compact pill ＋ buttons (as bitcoin-explorer's toggles), flows scroll each step into view, clearer visualization-form labels.
- **Dark theme** — dark only; colour tokens by job (blue interaction, violet datasets, orange
  transforms, green visualizations, amber attention + mark, orchid Search matches); dark basemap.
- **Run all stale** — ↻ pill (graph + list): stale transforms and everything downstream, inputs
  first, stops on the first failure (`staleRunOrder`).
- **Workspace in the header** — Workspace button (amber ● when unsaved) with a drop-down panel; list
  panels ordered Visualizations / Transforms / Datasets with the same ＋ pills.
- **Graph pan / zoom** — drag, Shift + wheel, trackpad pinch; phones: hold then drag, pinch.
- **Dataset stores + copy / paste workspace** — `DatasetRecord.store` (`local` | `remote`, missing =
  local; `storeOf`), a Local / Remote chip on dataset cards; dataset menu **Move to remote storage**
  (`moveDataset`: answers that remote storage isn't available yet) and **Delete dataset**
  (`deleteDataset` + workspace op `forgetDataset`: refused while a transform reads it; outputs that
  wrote it make a new dataset next Run). Workspace panel: **Copy workspace** (the file's JSON to the
  clipboard) and **Paste workspace…** (a box filled from the clipboard; Clear / Load). Agent tool
  design and workflow written up in `docs/agents.md`.
- **Desktop view on a phone** — footer button (touch devices; remembered on the device): lays the page
  out 1,280 wide and shrinks it to fit (`src/desktopView.ts`, viewport set in `main.ts`; pinch zoom
  stays free), to see and test desktop-only layout on the phone. Turning the phone sideways keeps the
  phone layout on purpose.
- **Several files at once** — ＋ Dataset → CSV / GeoJSON takes multiple files; each is uploaded in
  turn as its own dataset (progress per file; a failed file is listed with its reason and the rest
  still go in). Long dataset and file names in the add panel end in … instead of widening the page.
- **Client / server audit (E)** — the three server-shaped jobs left in the client moved behind
  requests: seeding the default map (`seedDefaultWorkspace`), reading rows for a preview
  (`datasetRows`; the client's `readDb` is now a `RecordReader` with no `readRows`), and building
  exports (`exportVisualization`; `lib/arcgis` is server-only). `src/client/boundary.test.ts` keeps it
  that way. Reviewed and left client-side by design: the workspace draft and its ops, the agent loop
  (user's key), rendering / styling / legends, search and layout over loaded lists, stats over drawn
  values, record reads, device preferences.
- **Agent edits the workspace as files** — the agent edits a staged copy of the workspace, one small
  file per item (`workspace.json` index, `transforms/<id>.json` + `<id>.<key>.sql`,
  `visualizations/<id>.json`, generated `overview.md`), with Anthropic's text editor tool, then
  `apply_workspace` checks it all and applies it (replies with the ids of new items). SQL is never
  written inside JSON. Replaces `update_workspace`. Our tools are strict; SQL errors point at the
  agent's own SQL, once.
- **Spatial extension** — DuckDB's spatial extension loads on first use (allowlist in
  `shared/sqlExtensions.json`; a query naming its functions loads it and retries), hosted with the
  app by the Netlify build (falls back to DuckDB's repository). GEOMETRY results come back as GeoJSON.
  Transforms record the extensions they use (`requires`); a workspace's load ahead when it opens and
  travel in workspace files. The agent knows ST_Area_Spheroid, ST_Transform and spatial joins.
- **Engine speed** — one DuckDB copy per dataset whatever alias a query uses (aliases are temp
  views), bulk-loaded as Arrow (3,071 × 330: ~11 s → ~0.5 s), least recently used copies dropped past
  a cell budget, queries one at a time, paged queries run once. Renaming / describing a dataset no
  longer marks its transforms stale. The agent re-reads the workspace before saying something's
  missing.
- **Assistant: the dataset processor agent** — ✦ Assistant in the header opens a chat (side panel
  on desktop, sheet on phones). The user's own Anthropic API key stays on the device; calls go
  straight to Anthropic (`claude-opus-5-5`, streaming). The agent reads the workspace, queries any
  dataset (DuckDB), replaces the draft (`update_workspace`, all-or-nothing with every problem
  listed), runs transforms and deletes local datasets, all through the page's own functions; the
  server refuses its changes to remote datasets (`caller: 'agent'`). `src/lib/agent/` (provider
  contract, loop, tools, prompt), `src/client/agent/claude.ts`, `components/agent/AgentPanel.vue`.

## Next (Current Sprint)

One-time setup — tick these off as they're done:

- [x] Connect Netlify (finish-setup) — required; gives previews AND the production site
      (site: https://powergis.netlify.app)
- [x] Protect `main` (finish-setup) — required; this is what makes changes arrive as PRs with
      preview links, instead of going straight to the live site
- [x] Review the utilities-by-county map on a phone (now built from datasets + a join transform)

## Code

### Roadmap (agreed order)

Everything the UI can do must also be a plain, serializable operation with machine-readable
results, because the agent workflow (step 5) drives the same operations as the UI.

1. ~~**Workspace document + operations + on-device persistence**~~ (done, see Done; derived datasets and tabs join the document in steps 2 and 5) — one serializable workspace
   (datasets, derived datasets, visualizations, tabs); a single operations layer (add dataset,
   add derived dataset, add/reorder visualization, …) used by both UI and agents. Datasets carry
   only **standard metadata** (name, description, created/updated, columns, profile) plus an
   open-ended extension slot for features to attach their own; **sources and usage policy are not
   dataset properties** — they belong to the agent workflow's records (step 5). Saved on the device (localStorage for specs, IndexedDB for tables). Dataset drag-reordering.
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
4. **DAG** — first version done (see Done): a Graph view of datasets → transforms → outputs →
   visualizations, auto-laid-out, where transforms and visualizations can be added and opened.
   Still open: saved node positions / dragging, rewiring by dragging edges (computers), and later a live view of agent pipelines (with their source / usage-policy records).
5. **Agent workflow (data finding)** — see below.
6. **Tabs, with a widget layout** — see *Display model* below. Datasets are shared; each tab owns
   its transforms, visualizations and widgets, and has its own map view and DAG. **New** (blank),
   **Duplicate** (independent copies; duplicated transforms write fresh outputs, since a dataset
   has one writer) and **Derived** (pick **anchors** — datasets, transforms, visualizations — from
   another tab: shown locked 🔗, live, editable only in their source tab; "detach a copy" to edit;
   "Link from another tab…" later in any tab). Even with only a map widget, a tab holds a *list of
   widgets* so charts slot in without a migration. **Phones: tabs only**; a tab's widgets stack.
   **SQL engine per tab:** one DuckDB serves every tab while their workspaces' extensions
   (`requires`) can share it — opening a tab only adds the extensions it needs. A tab whose
   extensions conflict with the loaded ones (`conflictsWith` in `shared/sqlExtensions.json`; none
   do yet) gets its own engine (an engine pool keyed by extension set).
7. **Charts (static)** — a chart widget; visualizations grouped by x (+ series) with y and color
   encodings, marks line / bar / scatter. Useful before any interactivity.
8. **Interactivity** — variables, events → variables, views, widget filters (see *Display model*).
   E.g. a map of 2024 prices by county; tapping a county sets `county`; a view
   `SELECT year, avg_price FROM prices WHERE county = :county` feeds a time-series chart.
9. **Agents compose displays** — everything above is serializable config, so agents can build
   "map + chart on click" setups as well as datasets.

### Codebase audits (agreed 2026-10-27; schedule before tabs / a real backend)

1. ~~**Client / server separation.**~~ (done, see Done) Goal: moving the server to a real backend (Supabase / HTTP) is a
   transport swap. Everything backend-shaped — reading sources (fetching files, ArcGIS, CSV parsing),
   writes, grouping / aggregation, SQL, indexing, profiles — lives in `src/server/` (or pure `lib/`
   used *only* by it); components only `request(…)` or `readDb` and render.
   Check: every `src/lib` import from `src/components` / `src/client` is type-only or genuinely
   client-side (styling, layout, search over already-loaded lists); no `fetch` of data outside the
   server (known: `MapPage.seedDefault` fetches the default workspace file; `lib/data/connectors.ts`
   is imported client-side; `DataExchange` exports in the client). Output: a list of moves, then PRs.
2. **Component reusability.** Goal: the UI is composed from a small set of shared components, no
   inline one-off panels / buttons / cards / lists / modals / grids. Today: `ObjectList` (cards +
   hold menu) and **`UiButton`** (`components/ui/`, sizes tag / compact / regular / large, tones by
   job: pills, header, icon and assistant buttons use it) are shared; still by hand — text `.btn`
   styles in ~6 components (Save, Run, Cancel, Preview…: move them to `UiButton`), modal
   backdrops in 3 (pop-out, Help, Explore), `.close` buttons in 3, chips in 3, a separate
   `PreviewTable` vs `FeatureRows` table. Check: inventory every repeated pattern, then extract
   `Button` (variants: primary / ghost / danger / icon / pill), `Modal`, `Panel` (collapsible, with
   header actions), `Chip`, `DataTable` (paged, typed cells), `Menu`, form `Field` rows, and migrate
   call sites. Tokens + variants, not per-component CSS.

### Display model (agreed 2026-10-26)

Three layers; maps and charts are the same kind of thing:

| Layer | What | Kinds |
|---|---|---|
| **Source** (data) | a table of rows | **dataset** (stored, lineage, staleness, run on demand) · **view** (a SELECT computed on the fly, never stored, may use variables, re-evaluates when inputs or variables change) |
| **Visualization** (encoding) | a source + a **grouping key** (which columns make one mark) + aggregation + channels (columns → color / size / x / y …) | map layer: key = geometry (+ name) · chart series: key = x (+ series) |
| **Widget** (display) | a coordinate space holding an ordered stack of visualizations | **map** (geographic) · **chart** (axes) · later table, … |

- **A mark is a group of rows** identified by its key values — on maps too (a county in
  utilities-by-county is many rows). One-row-per-mark is just a unique key.
- **Selection** on any widget = `{visualizationId, key}` → the rows behind the mark. The map's
  selected feature already has this shape.
- **Variables** (per tab: name, type, default, value; editable as a small form) are set by
  **events** configured in the UI ("when a feature is selected on *Map* → set `county` to its
  *fips*"), binding either the **key value** or a **column of the selected rows** (one value if all
  rows agree, else a list for `IN :var`).
- **Views** take variables as **bound parameters** (never pasted into SQL). Run in the DuckDB
  worker, debounced, stale answers dropped (the Find `seq` pattern). The common case needs no SQL:
  a **widget filter** `column = {variable}` on a dataset.
- **Transforms stay persistent and on-demand — no autorun.** Reactive steps are views; rewriting
  a stored dataset on every click would churn staleness, lineage and the one-writer rule.
- **DAG:** variables become nodes; dashed "reactive" edges map → variable → view → chart.
- **Code shape later:** the geometry binding generalizes to a grouping key; a new `Widget`
  `{type: 'map' | 'chart', visualizationIds, settings}` (today's visualization list = the map
  widget's layers); a tab = an arrangement of widgets.
- **Keep now:** transforms as pure SELECTs; map selection as an emitted `{visualization, key}`.

**Decided:** DuckDB for SQL · agents run **in the app** (the loop in the page, each user's own
Anthropic API key on their device, calls straight from the browser) · agents read any dataset and
change only **local** ones (see `docs/agents.md`).
**Postponed:** user login / cloud workspace · split screen · PowerGIS as a connector in the Claude apps.
**Order:** data-finding agents → tabs (widget layout) → static charts → interactivity → agents
composing displays — each step useful alone, none reworked by the next.

### Agent workflow (step 5)

The tool design, gates and workflow are in **`docs/agents.md`**. Build order:

1. ~~Dataset stores, Move / Delete, Copy / Paste workspace~~ (done).
2. ~~Query speed-up~~: already there (loaded tables stay in DuckDB until their dataset changes).
3. ~~**Dataset processor agent**~~ (done): API key setting, chat panel, the loop, the six data
   tools: `get_workspace` (where it starts), `list_datasets` (the app's dataset finder; only with
   the user's OK), `ask_user` (Approve / Reject + notes), `query_sql`, the text editor + `apply_workspace` (was `update_workspace`),
   `run_transform`, `update_dataset`, `delete_dataset`, the server-side gate for `caller: 'agent'`.
4. **Scouting and scraping**: web search / fetch for the agent, `create_dataset(rows)` (local,
   size-capped) for data it collects itself, scout source reports, run records. Options for
   **D1** (fetch + create_dataset, no agent code) and **D2** (agent-written scripts: Managed Agents
   container vs. Pyodide) are written up in `docs/agents.md` → *Next: scouting and scraping*.
5. **Supabase**: login, the remote store (Move to remote / local for real), storage limits.

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

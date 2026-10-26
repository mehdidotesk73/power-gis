# CLAUDE.md

Guidance for any Claude session working in this repo. Read this first. The
repeatable procedures live in `.claude/skills/` — `finish-setup` for one-time
setup, `ship-feature` for every change after that.

## ⚠️ FIRST: Is `docs/setup-brief.md` present?

**Check before reading anything else.** If this repo has a `docs/setup-brief.md`, then it is
somebody's freshly scaffolded project waiting to be set up. Invoke the **`finish-setup`** skill.
(This project has no brief — setup personalization is done; see `docs/TODO.md` for what's left.)

## If someone asks to start a *different* app here

If the user asks to **build a new webapp**, mentions the template repo, or pastes the template's
setup prompt into a session open on this project: **they are starting a new project, not changing
this one.** Don't answer from this repo. Fetch
https://github.com/mehdidotesk73/claude-nocode-netlify-webapp-workflow — read its `CLAUDE.md` and
follow those setup instructions, which begin by walking them through creating a new repository.

Never scaffold the new app into this repository.

## What this is

A Vue 3 + TypeScript + Vite single-page app (also a PWA) that **displays power-sector data on a
map**. The map is built from GeoJSON features of three primitive geometry kinds — **point,
polyline, region** — each carrying typed properties (`int`, `double`, `string`, `datetime`,
`boolean`, and `list` / `dict` / `struct` compositions of them). Data is organized to round-trip
cleanly with ArcGIS (Esri JSON FeatureSets, GeoJSON, CSV, FeatureServer REST).

UI structure — one page, the **Map**:

- **Controls** (left sidebar on desktop, below the map on phones): utility search, layer toggles,
  view presets, style editors (scalar + vector), ArcGIS import/export.
- **Map** (MapLibre GL) with:
  - **Scalar layers** — color (constant / colormap / categorical), transparency (fixed / by
    field), fill pattern (none / all / by field).
  - **Vector layers** — arrows with direction from the vector, size from magnitude, plus color and
    transparency encodings.
  - **Hover tooltip**, **click → feature panel** (generic property table plus an optional custom
    dashboard per layer), **legend**.
- **First dataset**: every US electric utility and the counties it serves (EIA Form 861 Service
  Territory, report year 2025), as `public/data/utility_counties.csv` → a county region layer.

The entire app is wrapped inside a header and footer. The header provides the app title, a Help button that opens the conceptual-docs modal, and an "Update available" affordance that surfaces when a newer PWA build is live. The footer provides the current build id/timestamp, version-check status against the live origin, a "Reload latest" button to force-refresh a stale cache, and a collapsible debug log with copy-to-clipboard support. See `docs/system-design.md` §2 for the full wrapper template and implementation details.

The user previews on a **phone** (mobile Safari), so favour mobile-friendly layouts and remember there's no dev console on device — see Debugging below.

## Getting Started

**Setup not finished?** Check the checklist under **Next** in `docs/TODO.md`. If
anything there is unticked, run the **`finish-setup`** skill — it's resumable and
does only what's outstanding.

**Ready to build?** Every change goes through **`ship-feature`**. See below.

## Development lifecycle

Every change — feature, fix, or tweak — goes through the **`ship-feature`** skill
(`.claude/skills/ship-feature/SKILL.md`): branch off `main`, build before each
commit, push, wait for the Netlify preview, run the pre-merge doc gate, open the
PR, hand the user preview + live + merge links, then watch the production deploy
after they merge.

Two rules that hold regardless:

- **Never work on `main`.** It's protected; pushes are rejected. If you find
  yourself on it, branch before doing anything.
- **The user merges, not you.** They can't merge what they can't find, so a PR
  turn always ends with the links.

**The skills in `.claude/skills/` are a copy, not a subscription.** This project
was scaffolded from a template by file copy, so fixes made to that template since
never arrive on their own. The **`update-skills`** skill pulls them in. Worth
offering when a step in setup or shipping goes wrong in a way that sounds like a
known bug — but don't run it mid-feature; it's housekeeping, not a fix for
whatever they're actually asking about.

## Build & verify

- **Type-check + build:** `npm run build` (runs `vue-tsc -b && vite build`).
  This is the gate — it catches TS errors _and_ Vue template parse errors.
  **Run it before every commit.**
- **Unit tests:** `npm test` (vitest). Tests live beside the code as `src/lib/*.test.ts` and cover
  the foundations later features sit on: the schema, style → expression translation, ArcGIS
  conversion, and the utility CSV join.
- **CI runs build + tests on every PR** (`.github/workflows/ci.yml`, one job named `build`), and the
  branch ruleset requires it to pass before merge. Tests stay inside that one job — never a separate
  job, since the ruleset only watches `build`.
- **External data dependencies:** the basemap (OpenFreeMap Positron vector tiles, free, no key; the map falls back to a plain background if they fail), and — only when
  rebuilding the CSV — the PUDL mirror of EIA-861 on S3. The app's own data is static in `public/`.
  From this sandbox eia.gov and census.gov are blocked; the PUDL S3 bucket is reachable. You cannot
  see the rendered map here unless you drive a headless browser; lean on the user's screenshots.

## Data

- `scripts/build_utility_counties.py [year]` regenerates `public/data/utility_counties.csv` (one row
  per utility × county) and `public/data/utilities.csv` (one row per utility) from EIA-861 via
  PUDL. It needs `pandas` + `pyarrow`; downloads are cached in `scripts/.cache/` (git-ignored).
- County polygons come from the `us-atlas` npm package (Census 2017 cartographic boundaries,
  1:10m). EIA-861 still reports Connecticut's eight legacy counties, which match it.
- **Client / server boundary** (everything runs in the browser today, but split as if it didn't):
  - **Server** (`src/server/`): a **Web Worker** (`worker.ts`) running `createServer` (`server.ts`).
    It owns every **lasting change** and every **heavy computation**: uploads, dataset edits,
    visualization values, feature rows, saving workspaces. Answers are pointers (uuids) or small
    results, as `ApiResult` (`{ok, data}` / `{ok:false, error:{code,message}}`) — never throws.
  - **Contract** (`src/shared/`): `api.ts` (request types), `records.ts` (base tables), `database.ts`
    (`ReadDatabase` / `Database` + in-memory test DB), `idb.ts` (IndexedDB), `builtins.ts`.
  - **Client** (`src/client/`, components): `request(type, payload)` (`api.ts`) for anything that
    writes or computes; `readDb` (`db.ts`, read-only) to read records and rows. **Components never
    write the database.** New features that change data add a request type, not client code.
- **Database** (IndexedDB `powergis-db` on this device; Supabase later). Base tables, every row with a
  uuid `id` + editable `name`, no access control yet: `users`, `workspaces` (config of **pointers**:
  `datasetIds`, ordered `visualizationIds`), `datasets` (registry: data table name, columns, row
  count, origin, description, `extensions`), `transforms` (SQL + input/output ids — table only, runs
  in step 2), `visualizations` (dataset id + settings). **Each dataset is its own data table**
  (`ds_<uuid>`). Datasets carry standard metadata only — **source and usage policy are not dataset
  properties**.
- **Concepts — keep the names straight:**
  - **Connector** (`src/lib/data/connectors.ts`): how the server reads a source (built-in CSVs,
    device files, in-memory tables, ArcGIS features via `featureTable`).
  - **Dataset**: a plain table in the database, by id. No geometry of its own.
  - **Visualization** (`src/lib/dataset/visualization.ts`): a dataset pointer plus settings —
    **geometry binding** (`geometry`: a geometry column; or the stopgap `boundary`: region codes
    joined to built-in US county/state polygons until transforms can join a boundary dataset),
    column, `Aggregation`, style. **No lat/lon pairs**: a visualization draws real features. The server groups rows onto features and
    aggregates (`lib/dataset/query.ts`, cached per dataset+binding); the client attaches boundary
    polygons from static files (`visualizationLayer`). Any number per dataset; one ordered list.
    **Top of the list draws on top** (within its geometry kind): widgets register their map layers
    in `ctx.stacks` and `MapView.restack` moves them to match. Restyling never refetches values.
- **Workspace** (`src/lib/workspace/workspace.ts`): the client's working copy (dataset pointers +
  ordered visualizations); **every edit is an operation** returning `{ok, doc}` or
  `{ok:false, error}` — the UI uses them and agents will too. **Explicit Save**: edits are a
  draft (localStorage `powergis.draft`, restored on reload, "Unsaved changes" + Discard in
  `WorkspaceBar`) until Save sends `saveWorkspace`. **Workspace files** (`lib/workspace/file.ts`):
  download / load a `.powergis.json` of pointers + settings, never rows; loading replaces the
  working copy (fresh visualization ids, datasets missing from the database dropped and reported).
  Details: `docs/system-design.md` §4.
- **Vector is a primitive type** (`schema.ts`: `{u, v}` = east, north). A visualization's kind follows its
  column: vector columns → arrows, everything else → scalar (color / transparency / pattern).
  Vectors are read from `[u, v]`, `(u, v)`, `u,v`, `{"u":…,"v":…}` cells, or combined from two
  numeric columns (`addColumn` request, `from: {kind: 'vector'}` → `withVectorColumn`). They aggregate component-wise (sum / mean).
  ArcGIS has no vector type, so exports split them into `<name>_u` / `<name>_v` Double fields;
  our schema sidecar rebuilds them on re-import.
- **Categorical colors** (`lib/palettes.ts`): every value gets a color — no category cap. Palettes
  `p12` / `p24` / `p60` are fixed, nested lists (each extends the smaller, starting from Tableau 10)
  that repeat when values outnumber them; `many` makes lightness variations of the 12 hues for any
  count; `auto` (default) picks the smallest that fits. Values are colored in sorted order, so a
  value keeps its color as data changes. Use `paletteColors(name, n)` for any widget (charts too).
- **Geometry columns** are column types — `point`, `polyline`, `region` (closed polylines) —
  holding GeoJSON geometries in lon/lat (WGS84); cells may arrive as GeoJSON or WKT and are coerced.
  Geometry is set up at **ingestion**: GeoJSON / Esri / ArcGIS features get a typed geometry column;
  a table with an obvious lat/lon pair (`guessLatLon`) and no geometry gets a `location` point
  column (`withPointColumn`). Otherwise the dataset editor's **Add a column** (`addColumn` request:
  point from lat/lon, or vector from east/north) — later, transforms.
- Column types are inferred (`inferColumns`); zero-padded codes stay text.
- **Draw order** follows geometry, not add order: regions → lines → points → arrows, all under the
  basemap's labels (invisible slot layers added in `MapView`).
- **Presets:** the built-in EIA-861 dataset is a normal dataset with preset visualizations
  (`utilityStyles.ts`) plus extras keyed by `preset: 'utilities'` — the county dashboard and
  utility search. Other datasets get the generic rows table in their click panel.
- **Visualization list UI** (`VisualizationList.vue`; `DatasetList.vue` reorders the same way via `useDragReorder`): drag the ≡ handle to reorder, swipe left to
  reveal Delete — pointer events (not HTML5 drag-and-drop, which iOS lacks); the row uses
  `touch-action: pan-y` so vertical scrolling stays native.
- Join key everywhere is the 5-digit county FIPS string (`county_fips` / `fips`). Keep it a
  string: leading zeros matter.

## Deploys

- **Netlify does both jobs** (`netlify.toml`): pushes to `main` build the **production** site at
  `https://powergis.netlify.app`; every other branch/PR gets its own **Deploy Preview**
  at `deploy-preview-<n>--powergis.netlify.app`. One host, one build pipeline — nothing
  else to configure for hosting.
- **`.github/workflows/ci.yml` only runs the build check on PRs** — it doesn't deploy anything.
- **`package-lock.json` is committed and must stay that way** — CI runs
  `npm ci`, which fails outright without a lockfile in sync with
  `package.json`. Commit the lockfile whenever you change dependencies.

## Repo structure

```
src/
  App.vue                  header/footer shell (see docs/system-design.md §2) + the map page
  main.ts, pwa.ts          bootstrap; service-worker auto-update + reload
  debug.ts                 on-screen log: auto-captures errors + logDebug() (mobile has no console)
  lib/                     pure logic, no DOM/map — unit-tested
    schema.ts              field types, LayerData, schema inference
    style.ts               ScalarStyle / VectorStyle → MapLibre expressions + legends
    colormaps.ts           colormap stops
    palettes.ts            categorical palettes (12 / 24 / 60 fixed, many, auto) — reusable beyond the map
    rasters.ts             pattern tiles + arrow SDF as raw RGBA
    arcgis.ts              Esri JSON / GeoJSON / CSV import-export, FeatureServer fetch
    geometry.ts            anchor points (centroids), bbox
    utilities.ts           EIA-861 typed rows + utility list (search)
    data/connectors.ts     connectors: how sources are read
    workspace/             the client's working copy + operations (workspace.ts), files + drafts (file.ts)
    dataset/               columns, aggregate, binding (+ wkt), boundaries (loader), query (server-side grouping), visualization
    search.ts              ranked type-ahead search
    data/csv.ts            CSV → records
    demo.ts                synthetic vector field for exercising the arrow widget
  shared/                  client ↔ server contract: api, records (tables), database, idb, builtins
  server/                  the server (Web Worker today): server.ts handlers, worker.ts entry
  client/                  api.ts (requests to the server), db.ts (read-only database)
  components/
    map/                   reusable map widgets
      MapView.vue          the map; provides it to child layer widgets
      ScalarLayer.ts       renderless: points / polylines / regions with a ScalarStyle
      VectorLayer.ts       renderless: arrows with a VectorStyle
      FeatureTooltip.vue   hover card
      FeaturePanel.vue     click panel: custom dashboard slot + generic property table
      PropertyValue.vue    renders any typed value (recursive for list/dict/struct)
      MapLegend.vue        ramps + swatches (incl. patterns)
      ScalarStyleEditor.vue, VectorStyleEditor.vue
      DataExchange.vue     ArcGIS import/export UI
      SearchBox.vue        type-ahead search over any list (no <datalist>: iOS chokes on big ones)
    MapPage.vue            the page (a client): workspace copy, server values → map widgets, panels, legend
    dataset/            AddDatasetPanel, DatasetList, VisualizationList, VisualizationEditor, BindingEditor, FeatureRows
    workspace/WorkspaceBar.vue  name, Save / Discard, file download / load, reset
    UtilityCountyDashboard.vue  custom dashboard for a county
    utilityStyles.ts       view presets + ownership colors
    HelpModal.vue          renders docs/concepts/*.md into the Help modal
public/data/               utility_counties.csv, utilities.csv (generated)
scripts/                   data build scripts
docs/
  TODO.md                  living backlog (Done / Next branch / Housekeeping)
  experience.md            what didn't work + per-merge version history
  system-design.md         developer/system docs (§2 has wrapper template)
  concepts/*.md            per-page user docs (rendered into the Help modal)
.github/workflows/ci.yml       build + test check on every PR (required by the branch ruleset)
netlify.toml                   preview-deploy config (Netlify)
package-lock.json              committed — CI runs `npm ci` and needs it
```

## Conventions & gotchas

- **Pure logic lives in `src/lib/`** as plain functions over already-loaded data. Keep map- and
  DOM-specific code in `src/components/map/` and keep page components thin.
- **Adding a dataset** = an `uploadDataset` request (or a new `UploadSource` kind on the server);
  then visualizations of it via the ops. Dataset-specific extras (dashboard, search) key off
  `extensions.preset`; custom dashboards go in `FeaturePanel`'s default slot.
- **MapLibre flattens nested properties** into JSON strings in rendered features. Widgets emit only
  feature ids; look the original feature up by id (see `byKey` in `MapPage.vue`).
- **Patterns are a region encoding** (fill-pattern). Points/polylines ignore `style.pattern`.
- **Vector direction convention:** degrees clockwise from north, pointing where the vector goes;
  `u` = east component, `v` = north component.
- **ArcGIS type mapping** is in `src/lib/arcgis.ts`'s header comment. Composite types travel as JSON
  strings in Esri fields; our full schema rides along under the `x-powergis` key.
- **Mobile-first:** the user is on a phone. Keep controls tappable; hover is only a bonus
  (tooltips are suppressed on touch devices, tap opens the panel).

## Version freshness

- Every build writes `version.json` (`{commit, builtAt}`) via the `emit-version-json` plugin in
  `vite.config.ts`; the build id is `VITE_BUILD_ID`, else Netlify's `COMMIT_REF`, else git.
- `src/lib/useVersionCheck.ts` polls it every 60 s and compares it with `__BUILD_ID__`: the
  footer shows "up to date" or "<commit> is live", and the header shows **Update available**.
- `src/pwa.ts` registers the service worker itself (`injectRegister: false`), checks for new
  deploys every 60 s and auto-reloads into them. Manual **Reload latest** unregisters the SW, clears
  caches and navigates with `?fresh=` (stripped in `main.ts`), because a polite SW update proved
  unreliable on iOS.

## Debugging on device (no console)

- **Errors are captured automatically.** `installErrorCapture(app)` in
  `main.ts` routes four sources into the on-screen log: Vue's
  `errorHandler`, `console.error`/`console.warn`, `window.error`
  (including failed resource loads), and `unhandledrejection`.
- The footer shows **View logs** with a red count badge when errors exist;
  the panel has **Copy log**, which includes build id, user agent and URL.
  **Ask for it by name** — "tap View logs, then Copy log, and paste it here".
- `logDebug(msg, kind?)` exists for deliberate diagnostics. The map logs tile/style errors and the
  data load summary there.

## Reference docs

- `.claude/skills/finish-setup/SKILL.md` — scaffold personalization + one-time hosting setup (resumable).
- `.claude/skills/ship-feature/SKILL.md` — the loop for every change.
- `.claude/skills/add-github-pages/SKILL.md` — optional Netlify-independent mirror, on request.
- `docs/TODO.md` — current backlog and what's been done.
- `docs/experience.md` — dead ends (with reasons) + version history.
- `docs/system-design.md` — developer/system documentation; §2 contains the wrapper template.
- `docs/concepts/*.md` — per-page user docs, also rendered into the Help modal.

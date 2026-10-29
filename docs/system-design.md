# System Design — Architecture & Patterns

Developer-facing documentation of how the app is structured, how data flows, and design decisions.

## §1 — System Overview

This is a Vue 3 + TypeScript + Vite single-page app (SPA) that works as a progressive web app (PWA). It provides:

- **Header/footer shell** — app title, Help modal, build/version info, reload affordance, debug panel
- **Service-worker caching** — offline capability, smart update detection
- **Mobile-first UX** — responsive, touch-optimized, no hover-only interactions
- **Pure computation layer** (`src/lib/`) — reusable logic separated from UI
- **Hot reload in dev** — instant feedback on code changes
- **Netlify** — production site and a live preview on every branch/PR, one host

### Architecture Diagram

```
┌─────────────────────────────────────────┐
│           Browser (PWA)                 │
│  ┌───────────────────────────────────┐  │
│  │  Service Worker (cache, updates)  │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  App.vue (header/footer shell)    │  │
│  │  ├─ HelpModal                     │  │
│  │  ├─ DebugPanel                    │  │
│  │  ├─ UpdateAvailablePrompt         │  │
│  │  └─ <your content here>           │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  lib/ (pure functions)            │  │
│  │  ├─ Data fetch & cache            │  │
│  │  ├─ Computation logic             │  │
│  │  └─ Utilities                     │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  External APIs (if needed)        │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## §2 — Header/Footer Wrapper Template

This is the shell that wraps every page/tab. It provides version checking, update affordances, Help modal, and debug logging. See `src/App.vue` for the full implementation.

### Key Features

1. **Header** — app title (centered), Help button (top-right), "Update available" button (top-left when new version detected)
2. **Footer** — build ID/timestamp (clickable to expand debug log), "Reload latest" button, version status
3. **Debug panel** — collapsible log of on-screen messages (no console on mobile)
4. **Help modal** — renders markdown docs from `docs/concepts/*.md`
5. **Update detection** — background check against live origin, prompts user when new build is available

### Version Checking Logic

- On load, `useVersionCheck()` compares the loaded build ID against what's live at the origin
- States: "current" (up to date), "update-ready" (new build is live), "checking" (in progress)
- "Reload latest" button: checks again, then reloads if a new version exists
- Service worker auto-updates in the background; the version check surfaces this to the user

### Styling

**Dark only** (`color-scheme: dark`; no light theme). Every colour is a token in `src/styles/vars.css`,
and components use tokens, never literals:

| Token | Value | Job |
|---|---|---|
| `--bg` / `--bg-elev` / `--bg-elev-2` / `--bg-input` | `#0b0f18` / `#141b2a` / `#1b2334` / `#1f2940` | page + graph canvas / panels / buttons, cards, menus / inputs |
| `--border` / `--border-strong` | `#28324a` / `#36425f` | edges / button edges, arrows |
| `--text` / `--text-muted` | `#e7eaf3` / `#8b94ac` | text / hints, counts |
| `--accent-blue` | `#4f8ef7` | **interaction only**: focus, hover, primary buttons, links, selected arrows |
| `--kind-dataset` (violet) | `#9b6dff` | datasets: graph nodes, ＋ Dataset |
| `--kind-transform` (orange) | `#f7931a` | transforms: graph nodes, ＋ Transform |
| `--kind-viz` / `--ok` (green) | `#3ad29f` | visualizations; success messages |
| `--warn` (amber) | `#fbbf24` | needs attention — **always with a mark** (↻ needs-re-run badge, ●, ⚠), since orange is a neighbouring hue |
| `--danger` / `--danger-bg` | `#f87171` / `#3a1d24` | errors, Delete |
| `--overlay-bg`, `--backdrop`, `--shadow` | | map cards (legend, tooltip, panel), modal backdrops, shadows |

The page background adds two faint glows (blue top-left, violet top-right). Form controls get the
theme from a zero-specificity `:where(…)` rule, so component styles always win; MapLibre's zoom and
attribution controls are themed there too. The map can't read CSS variables, so its colours live in
`lib/mapTheme.ts`: Search matches **orchid** `#f0a3e4` (in neither viridis nor the categorical
palettes), the hovered / tapped feature white, default pattern ink and arrows light. New shapes get
thin dark seams (`#0b0f18`) between them. Basemap: OpenFreeMap **dark**, else CARTO **Dark Matter**,
else a plain `#0e131d` background (`MapView` tries them in order). Data draws above every basemap
fill and line (roads, borders) and under the trailing run of label layers, whose text `MapView`
repaints light in a dark halo (`LABEL_TEXT` / `LABEL_HALO`) so it reads over any fill. Mobile-safe padding with
`safe-area-inset` for notch/bottom-bar devices.

## §3 — Data Layer (api/)

Where to put external data fetches. Example structure:

```
src/api/
  example.ts       fetch & cache logic
```

Keep fetches synchronous from the component's perspective using a composable (below) that caches results.

## §4 — Shared Logic (lib/)

Pure functions over already-fetched data. These recompute instantly, no refetch. Example:

```
src/lib/
  indicators.ts    e.g., moving average, Bollinger bands
  compute.ts       custom app logic
  utils.ts         helpers
```

Keep functions **pure** — same input → same output, no side effects.

### Categorical palettes (`lib/palettes.ts`)

Reusable by any widget that colors categories (map layers and legends now, charts later).
`paletteColors(name, n)` returns `n` colors:

- `p12`, `p24`, `p60` — fixed lists, nested (the first 12 of `p24` are `p12`), so a category keeps
  its color when a bigger palette is picked. Built once, deterministically: Tableau 10's first nine,
  then greedily the candidate farthest in CIELAB from all chosen so far, among colors with
  L 40–82 and chroma 22–62 (readable on light and dark backgrounds, same family as Tableau).
  Minimum pairwise ΔE ≈ 17.6 across all 60. Fixed palettes repeat when `n` is larger.
- `many` — `manyColors(n)`: the 12 hues in ⌈n/12⌉ lightness variations (original first, then
  alternately darker / lighter within ±24 L). Consecutive entries differ in hue.
- `auto` — the smallest fixed palette that fits, else `many`. The default.

Categorical color encodings (`style.ts`) color every distinct value (sorted, numeric-aware), honor
explicit `colors`, and pick the rest from `palette`. The editor shows a swatch strip, the value count
and a note when a fixed palette repeats; legends with more than 12 items go into three columns.

### Client / server boundary

Everything runs in the browser today, but the code is split as if it didn't, so moving to a real
backend (Supabase + functions) is a refactor, not a rewrite.

- **Rule:** lasting changes and heavy processing are **server side**. The client sends requests; the
  server writes the database and returns **pointers** (uuids) or small results; the client reads the
  database read-only.
- **Server** — `src/server/server.ts` (`createServer(db, env)`), run in a **Web Worker** by
  `worker.ts`. Requests (`src/shared/api.ts`): `init`, `uploadDataset` (CSV / GeoJSON-Esri file,
  ArcGIS URL, built-in table → new data table + registry row), `updateDataset` (sent on Save for the draft's `datasetEdits`),
  `deleteDataset` (cleans up visualizations and workspace configs), `linkToCloud` / `pushDataset` /
  `pullDataset` / `unlinkDataset` / `deleteFromCloud` / `cloudStatus` (cloud links: every dataset is a
  local copy, a linked one also has a cloud dataset — `DatasetRecord.link` `{cloudId, version, changed}`;
  rows as a gzip Arrow file in the bucket; manual push / pull, `conflict` when the cloud moved on unless
  `overwrite`; never an agent), `describeBinding` (features,
  unmatched rows, defaults), `queryVisualization` (one value per feature), `featureRows`,
  `previewTransform`, `runTransform`, `profileDataset`,
  `saveWorkspace` (upserts its visualization and transform records, deletes dropped ones), `deleteWorkspace`.
  The worker can restart (an error makes `client/api.ts` start a new one): the client sends a new
  worker its `init` again first and logs why the old one stopped, and the server finds or makes the
  local user on first need (`ensureUser`), so nothing depends on having seen `init`.
  Every answer is an `ApiResult`; errors carry `not_found` / `invalid` / `failed` / `unsupported`.
  Grouping a table onto features (`lib/dataset/query.ts`) is cached per dataset + binding and
  dropped when the dataset changes.
- **Client** — `src/client/api.ts` `request(type, payload)` posts to the worker (unwrapping Vue
  proxies, which can't be cloned); `src/client/db.ts` `readDb` is a `RecordReader` (records only:
  `get` / `list`; rows come from requests — `datasetRows`, `previewTransform`, `featureRows`).
  `src/client/boundary.test.ts` fails if client code imports server-only modules (`server/`,
  `shared/idb` outside `db.ts`, `lib/arcgis`, `lib/data/*`, `lib/dataset/profile`) or calls `fetch`
  (only `useVersionCheck` may) or `readRows`. Exports are `exportVisualization({visualization,
  format})` → `{fileName, mimeType, text}`, built from the server's grouping (`DataExchange` only
  downloads).
- **Database** — `src/shared/records.ts`. Base tables `users`, `workspaces`, `datasets`,
  `transforms`, `visualizations`: every record has a uuid `id`, an editable `name`, created/updated.
  A workspace's `config` holds only pointers (`datasetIds`, ordered `visualizationIds`). Each
  dataset's rows are their own data table (`ds_<uuid>`). Each dataset has a **store**
  (`DatasetRecord.store`: `local` on this device, `remote` in the shared database later; missing =
  local; `storeOf`): the same functions on both, and agents may change only local ones
  (`docs/agents.md`). Deleting a dataset from a card (`forgetDataset` op, then `deleteDataset`) is
  refused while a draft transform reads it. IndexedDB (`shared/idb.ts`, database
  `powergis-db`: one store per base table + `data`) on this device; `MemoryDatabase` for tests. No
  access control yet — an access layer between users and tables comes later.
- **Geometry columns.** `point`, `polyline` and `region` are column types (`lib/dataset/columns.ts`):
  GeoJSON geometries in lon/lat, inferred from GeoJSON or WKT cells (a mixed column takes its most
  common kind; cells of another kind coerce to null). Geometry comes with the data — features get a
  typed geometry column, WKT / GeoJSON cells are typed — and nothing is derived at upload: building
  a point from latitude / longitude (or a vector from two columns) is a transform.
- **Geometry binding is a visualization setting** — `{kind: 'geometry', column, label?}` draws a
  geometry column; rows with identical geometry become one feature (`groupRows` keys a shared object
  by identity, else by its JSON; `groupDataset` parses repeated GeoJSON text once), named by the first
  non-empty `label` value. There are no lat/lon or region-code bindings: a visualization always draws
  real features, and the server sends their geometry. Older saved visualizations of either kind are
  dropped on load with a log line and a "Reset gets the default map" note (`isSupportedBinding`).
- **Boundary datasets** — region codes become shapes by a join onto a boundary dataset: built-in
  `us_counties` / `us_states` (`lib/data/boundaryTables.ts`: us-atlas TopoJSON → rows with `fips`,
  names and a region `geometry`; read by the worker's `readBuiltin`).
- **Not dataset properties:** source and usage policy — they belong to the agent workflow's run
  records (roadmap step 5).

### Transforms (SQL that makes datasets)

**Shape:** inputs (`{datasetId, alias}`) and one or more outputs (`{key, name, sql, outputId?}`),
each output its own SELECT over the inputs. `runTransform` runs every output's SQL first and writes
nothing unless all succeed (an error names the failing output), then writes each into its
`outputId`'s table or a new dataset named after the output, and returns each output's pointer.
`previewTransform` takes one SQL. Single-SQL transforms saved before this (`sql` + `outputId`) are
read as one output by `normalizeTransform` — in drafts, workspace files and transform records.

A transform is one SELECT over input datasets, each called by an alias in the SQL; running it writes
its output dataset (`outputId`), or a new one when it has none. DuckDB-WASM is the engine.

- **Engine** — `server/duckdb.ts` opens DuckDB (exception-handling build only; iOS Safari 15.2+) in its
  own worker, started from the server worker, on the first transform request (`env.sql` in
  `worker.ts` is a dynamic import — hence `worker.format: 'es'` in `vite.config.ts`). The ~34 MB wasm
  (7.7 MB gzipped) is excluded from the PWA precache (`globIgnores: ['**/duckdb-*']`).
- **Runner** — `server/sql.ts` `createSqlRunner(engine, {cellBudget})`: keeps **one table per
  dataset** (`SqlInput.key` = dataset id; `__ds_<n>_<id>`), typed from our columns (int → BIGINT,
  double → DOUBLE, boolean, datetime → TIMESTAMP, string → VARCHAR, vector → STRUCT(u, v), geometry →
  VARCHAR GeoJSON). It's reloaded only when the version (`id|updatedAt`) changes; past `CELL_BUDGET`
  (8M cells) the least recently used tables are dropped. Loading goes through `engine.insert`: plain
  columns as an Arrow IPC stream (`server/arrowStage.ts`, `insertArrowFromIPCStream`; we pass bytes,
  since `insertArrowTable` with another apache-arrow copy's Table silently created nothing), then one
  `CREATE TABLE … AS SELECT` casts them (vectors travel as two doubles). Engines without `insert` get
  `INSERT … VALUES` batches (no `registerFileText` + `read_json`: that hangs DuckDB's Node build).
  Each query's aliases are `TEMP VIEW`s onto the dataset tables, so a new alias costs nothing;
  queries run one at a time (a queue), since the views are per query. Paged queries run once with
  `count(*) OVER ()` for the total. One SELECT / WITH statement only (`checkSelect`). Helper
  macros: `point(lat, lon)` → GeoJSON point text, `vector(u, v)` → `{u, v}`. Results are normalized
  (BigInt → number, timestamps → ISO text) and typed with `inferColumns`, so GeoJSON text becomes a
  geometry column and `{u, v}` a vector column; all-null columns fall back to DuckDB's type.
- **Extensions** — allowlist in `shared/sqlExtensions.json` (+ `sqlExtensions.ts`): name, purpose,
  size, `hosted`, `conflictsWith`, and the DuckDB version / platform the files are built for (a test
  checks `version()`). `autoload_known_extensions` is off; when a query fails with "…exists in the X
  extension", the runner loads X if allowed (`engine.loadExtension`), noting the function names it
  added (`duckdb_functions()` before and after), and runs the query again. Each run reports the loaded
  extensions whose functions the SQL calls (`name(`; not type names — GEOMETRY is also a common column
  name) as `SqlRun.extensions`. With spatial
  loaded, a `DESCRIBE` finds GEOMETRY result columns and a wrapping SELECT turns them into GeoJSON
  (`geometryAsGeoJson`). `duckdb.ts` loads from `<base>duckdb-ext/<version>/<platform>/<name>.duckdb_extension.wasm`
  when that file exists (a HEAD that isn't the SPA's HTML), else from `extensions.duckdb.org`. The
  Netlify build fetches hosted ones (`prebuild` → `scripts/fetch-duckdb-extensions.mjs`, only with
  `NETLIFY` or `FETCH_DUCKDB_EXT`; git-ignored; excluded from the PWA precache; a failed download
  doesn't fail the build).
- **Requests** — `previewTransform` (first rows + columns + full count + extensions used; nothing stored),
  `runTransform` (writes the output table, profile and record; updates a saved transform's
  `outputId` and `requires`; returns `requires`), `loadSqlExtensions` (load ahead; answers what's loaded
  and from where). **Workspace dependencies:** `TransformSpec.requires` comes from the last
  successful run; `workspaceRequires(doc)` is their union, written into workspace files as `requires`;
  `MapPage` loads it in the background whenever it gains a name. SQL errors come back as `invalid` with DuckDB's message. Deleting an output dataset
  clears transforms' `outputId` (next run makes a new one).
- **Client** — transforms live in the workspace draft (`TransformSpec`; ops `addTransform`,
  `updateTransform`, `removeTransform`; `removeDataset` refuses while a transform reads the dataset),
  saved by `saveWorkspace` (config `transformIds`) and in workspace files (fresh ids; transforms whose
  inputs are missing are dropped). `TransformsPanel.vue`: inputs (dataset — picked in a `SearchBox` matching name,
  typo-tolerant (`search(…, {fuzzy})`, edit distance 1–2), or id — **as** alias, with **Insert** at the SQL
  cursor; renaming an alias renames its whole-word uses in the SQL), SQL, Preview, Run (cards in an `ObjectList`: hold for Run / Edit / Delete). A missing
  table's DuckDB error is replaced by one listing the inputs' aliases (`server/sql.ts`). A run adds the output dataset to the workspace with a first visualization when it has geometry.
  Visualization values are keyed by the dataset's `updatedAt`, so a re-run refreshes the map.
- **Tests** run real DuckDB via `@duckdb/duckdb-wasm`'s Node build (`server/testEngine.ts`).

### Graph view (DAG)

The controls show the workspace as one graph (the default) or as lists (**List | Graph**,
remembered per device in localStorage `powergis.controlsView`). `lib/workspace/dag.ts`: `buildDag(doc, dataset)` makes nodes for every dataset (the
workspace's, plus transform inputs and outputs), transform and visualization, with edges input →
transform → output → visualization. Rows: datasets no transform makes are row 0; a transform is one
row below its deepest input and its output one below it; all visualizations share the bottom row.
Rows are ordered to minimize arrow crossings (`orderLayers`, the layered / Sugiyama recipe): an
edge that skips rows gets a virtual point (`v:<edge>:<row>`, listed in `edge.via` and `dag.layers`)
in each row it passes, so it takes a lane there instead of cutting across nodes; then up to 12
alternating down / up barycenter sweeps, each followed by adjacent swaps that lower crossings, keep
the ordering with the fewest crossings (row 0 starts in the workspace's dataset order).
`layoutDag(dag, direction)` gives pixel positions, `'vertical'` (rows top to bottom) or
`'horizontal'` (rows as columns, left to right); each row is centered on the widest, virtual points
take a narrow lane. `edgePath` draws an edge out of the parent's far side, through its points, into
the child's near side. The graph **pans and zooms** in a fixed viewport (`components/dag/usePanZoom.ts`,
maths in `lib/panZoom.ts`): mouse drag pans; Shift + wheel zooms, as does a trackpad pinch (Ctrl +
wheel, or Safari's gesture events); on touch, one finger still scrolls the page, touch-and-hold
(0.35 s, still) then drag pans, and two fingers pinch. A drag or pinch swallows the click after it, so
it never taps a node. It opens fitted (never above 1:1), refits when the layout or the viewport's
width changes (splitter, pop-out), and keeps part of the graph on screen; ＋ / − / ⤢ buttons sit in
its corner. The
direction toggle (↓ / →) is remembered per device (`powergis.dagDirection`); nothing else about the
layout is stored. Transform state: **not run yet**
(no output), **needs re-run** (an input's `updatedAt` is after the output's), else ready.

`DagView.vue` draws nodes as buttons over one SVG of curved edges. Tapping a node shows its card
under the graph using the list components filtered to that item (`compact` props hide their add
buttons and hints); holding the card gives its menu, exactly as in the lists. Only a transform or
visualization just created from the graph opens straight into its editor.

**Transform editor.** Inputs and outputs are one line each; the dataset picker (SearchBox) only
opens on ⇄ or for a new input. A **preview dock** (`TransformsPanel.vue`, sticky to the screen
bottom while the editor is in view, collapsible) shows one input or output at a time: an input's
first 20 rows via `datasetRows`, an output via `previewTransform` on its current SQL (nothing
stored). Geometry cells show their kind (`PreviewTable`), also for GeoJSON text from SQL.

**↻ Run all stale** (`staleRunOrder` in `dag.ts`): every transform that needs a re-run, plus every
transform downstream of one (already run, reading a pending one's output — it would be stale once that
rewrites its input), ordered so writers run before readers (depth-first; a self-reading transform
can't loop). Never-run transforms are skipped as possible drafts. `MapPage.runAllStale` runs them one
by one through the ordinary `runTransform`, shows "Running 2 of 3 · name…", and stops at the first
failure. The pill (amber, `.kind-pill.k-attention`) appears only when the list is non-empty.

Each dataset has at most one writer: each transform output writes a new dataset (made on Run) or
an existing dataset that isn't one of its transform's inputs and that no other output writes
(`checkTransform` in `workspace.ts`). Deleting a transform keeps its output dataset; that dataset
just can't be re-run until another transform is pointed at it.
**＋ Dataset** opens the add-dataset form under the graph and then the new dataset's card.
**＋ Transform** enters pick mode (tap input datasets, Next) and adds a transform whose inputs are
those datasets (aliases from their names, deduplicated), opened in its editor. **＋ Visualization**
picks a dataset and opens the visualization add form for it. Everything goes through the same
workspace operations as the lists.

### Side panel

On desktop the controls column is resizable: a splitter between it and the map (drag, arrow keys,
double-click resets), width as the `--panel-w` CSS variable on `.page`, remembered per device
(`powergis.panelWidth`, 256 px to 70% of the window). `MapView` keeps the canvas matched to its
container with a `ResizeObserver` (the window doesn't resize when the splitter moves). The
page has two **modes** (`mode`): **explore** (map first: the map column holds Find above the map and
Export below it; desktop keeps the side panel on the left — List | Graph | ⤢, then List | Graph, then the
open item, scrolling together in `.panel-body` (the phone's setup, without the mini map); phones show only the map and a sticky **setup
dock**) and **setup** (⤢ on desktop, the dock on phones; ✕ or Esc goes back): the page becomes one panel headed by the **List | Graph | ✕** row
(`.view-row`, grid area `head`: the top of the side panel in explore, spanning the page in setup). Desktop
setup has two columns: List | Graph over a mini map on the left, the open item on the right. Phone setup
has three rows: List | Graph, the open item, and a mini map sticky at the bottom; the page itself scrolls
(head sticky, `scroll-padding` top and bottom so revealed items land between them). MapView's
`min-height` is lifted for the mini map; the bar above it (`.map-splitter`, `useSplitter({side: 'bottom'})`)
sets its height (`--minimap-h`, remembered as `powergis.minimapHeight`; double-click resets). The modes only change CSS grid areas on `.page`, so the one
MapLibre map, open editors and selections survive (in setup `.panel-body` is `display: contents`, so
List | Graph and the open item take their own grid areas). A section, `#setup-detail`, always receives what the user opens:
the graph's open item (`<Teleport defer :disabled="!asideOn">`) and, through
`components/detailTarget.ts` (`provideDetailTarget` in the page, `useDetailTarget` in the lists), the list
editors (dataset / transform / visualization, not in their compact graph form) and Explore
(`ExploreModal`'s `asideTo`: a panel in the section instead of a window).

**Flows bring their next step into view**: `v-reveal` (`components/reveal.ts`) scrolls an element
into view when it appears or its value changes — just enough, or to its top when it's taller than the
screen. On: the graph when a pick mode starts, the graph's detail section, the visualization add
form, the transform editor and the list's add-dataset form.

### Explore

A dataset's menu → **Explore** (`components/dataset/ExploreModal.vue`, teleported modal; full screen
on phones): a SQL box starting `SELECT *\nFROM <alias>` above a results table that fills the rest of
the window, 200 rows a page with the total (`previewTransform` takes `offset` as well as `limit`,
capped at 1000; `server/sql.ts` adds `OFFSET`). Every workspace dataset is a table under
`aliasFor(name)` (deduplicated, the explored one first); only the ones the SQL mentions (whole-word
match) are sent as inputs, and the engine reuses tables already loaded for the same dataset version.
An unknown table's error lists every table you can use. Nothing is stored — for keeping a result,
write a transform.

### Find

`FindPanel.vue` (its own card above the workspace panels: "Search in [visualization] in [All data /
column]", then the search box) searches one visualization's features. The server indexes them (`findIndex`,
`lib/dataset/query.ts` `findIndex(grouped, columns)`): every feature label, and every distinct value
of every text column in the rows behind features, with how many features have it (columns over 20k
distinct values are skipped). The index is cached beside the dataset + binding grouping. The client
filters it by column (or All data) and searches it with `search(…, {fuzzy: true})`; picking an entry
asks `findFeatures` for its feature keys, which the page highlights on every visualization drawing
the same features (same dataset and binding) and zooms to (`focusBox`). Until the user picks a
visualization it follows the top visible one (they load one by one).

### Default workspace

The first visit (and Workspace → Reset) opens `public/data/default.powergis.json`, a v2 workspace document
with readable ids: four built-in datasets (`origin: builtin`) and the transform output
`default-utilities-by-county` (`origin: output`). The server's `seedDefaultWorkspace` (the worker reads the
file: `env.readDefaultWorkspace`; `MapPage.seedDefault` only asks and opens the result) runs `openDocument`
on it — built-ins reused or uploaded, the transform run once (or its earlier copy reused) — and the page opens it with
`fromWorkspaceFile`, unsaved like any loaded file (the very first one is saved at once). Today's file:
`utilities` + `utility_counties` (links) + `us_counties` + `us_states`; the transform **Utilities by
county** (`counties LEFT JOIN links LEFT JOIN utilities` — counties no utility reports keep one empty
row, so they draw as 0); visualizations Number of utilities (count of
`utility_id_eia`), Most common ownership, Co-op present (hatch) and State borders (`us_states`).
The first run loads DuckDB (~6 s on a desktop); later visits reuse the stored output.

### Dataset profiles

`lib/dataset/profile.ts` `profileRows(rows, columns)`: per column filled count, distinct count (capped
at 100k), min / max for numbers and datetimes; overall completeness. Stored on the dataset record
whenever its table is written (upload, transform run); `profileDataset` computes it for older
records. Shown in the dataset editor (hold menu → Edit).

### Workspace (`lib/workspace/`)

The client's working copy (`WorkspaceDoc`: server `id`, `name`, `datasetIds`, ordered
`visualizations`). **Every edit is an operation** — `addDataset`, `removeDataset` (out of the
workspace; the table stays), `reorderDatasets`, `renameWorkspace`, `addVisualization`,
`updateVisualization`, `removeVisualization`, `reorderVisualizations` — pure, returning
`{ok: true, doc}` or `{ok: false, error: {code, message}}`, so an agent can drive the same
operations and read why one failed. Dataset edits (rename, describe, vector columns) are server
requests, not workspace ops, since datasets are shared records.

`MapPage.vue` holds the copy in a `shallowRef` and applies ops through `apply()`.

- **Explicit Save.** Edits are a draft until **Save** sends `saveWorkspace`. `snapshot(doc)`
  (`file.ts`) is the stable text of what Save would store; the copy is dirty when it differs from
  the snapshot taken at the last save/open. While dirty, the draft (`{doc, saved}`) is kept in
  localStorage (`powergis.draft`) and restored on the next visit if it belongs to the opened
  workspace (pointers to datasets since deleted are dropped). **Discard** re-opens the saved
  workspace. Dataset uploads and edits are server writes right away — only the workspace is a draft.
- **Workspace files** (`file.ts`): `toWorkspaceFile` → `.powergis.json` with `format`, `version`,
  name, dataset ids and visualization settings — pointers, never rows. `parseWorkspaceFile` rejects
  anything else with a readable reason. `fromWorkspaceFile` loads into the current workspace (keeps
  its id), gives visualizations fresh ids (so they never collide with another workspace's records),
  and drops datasets the database doesn't have, reporting them. The load is a draft until Save.
  The same JSON goes to the clipboard (**Copy workspace**) and back (**Paste workspace…**: a box
  filled from the clipboard where the browser allows it, then Load) through `loadWorkspaceText`.
- **Reset** replaces the copy with the default utilities map (a draft; datasets stay in the database).
- On open it calls `init`, opens the last-used (or newest) workspace, or seeds and saves one with the
  built-in utilities dataset (reused if already uploaded). Visualization values are fetched per
  (dataset, binding, column, aggregation) and cached; restyling never refetches.

### Assistant (agents)

The design, tools and gate are in **`docs/agents.md`**; in short:

- `lib/agent/provider.ts`: the provider-neutral contract. A `ChatSession.send(text | toolResults)`
  returns `{text, toolCalls, stop, usage}`; the adapter keeps the provider's own history.
- `lib/agent/loop.ts`: `runAgent(session, runTool, text, events, signal)`: runs tool calls and sends
  results until the model answers in text; Stop (`AbortSignal`) and a 40-turn limit.
- `lib/agent/tools.ts`: `TOOLS` (JSON Schema definitions) and `runTool(host, name, input)`: validates
  input, applies the store gate, acts through an `AgentHost` (the page supplies it: the draft,
  `readDb`, the dataset finder `listDatasets()` (`client/datasets.ts`: local datasets today, plus the
  remote registry later), `request(…, 'agent')`, `describeBinding`, `runTransform`, `deleteForGood`). Never throws;
  every outcome is a message for the model plus a one-line summary for the chat.
  `workspaceVersion(doc)` stamps the draft; the staged files remember the version they were built
  from, so `apply_workspace` refuses edits made on an older draft.
- `lib/agent/workspaceFiles.ts`: the workspace as files (`workspaceFiles`), the text editor's commands
  on them (`runEditor`: view / create / str_replace / insert, only the workspace paths, overview.md
  read-only), `assembleFiles` (files → a full workspace description, file-level problems listed, new
  items given ids), `overviewText`, and the item forms (`agentTransform` / `agentVisualization`, also
  used to keep untouched items exactly). Staging per chat host lives in `tools.ts`.
- `client/agent/claude.ts` declares the editor as `{type: 'text_editor_20250728', name:
  'str_replace_based_edit_tool'}` (`ToolSpec.builtin`) and our own tools `strict: true`
  (`strictSchema`).
- `lib/agent/prompt.ts`: the dataset processor's instructions.
- `client/agent/claude.ts`: the Anthropic adapter (`startClaude`, `claudeProvider`, `describeError`).
  Browser-direct with the user's key, streaming, `fallbacks: "default"`, prompt caching.
- `components/agent/AgentPanel.vue`: the chat, opened by **✦ Assistant** in the header (teleported
  with the Workspace button into `#header-workspace`). Key in localStorage `powergis.anthropicKey`.
  Docked on the right of the page grid on desktop (`.page.assisting` adds a splitter and a
  `--assist-w` column; `useSplitter`), a fixed sheet on phones. Screenshots: paste / 📎, resized in
  `components/agent/images.ts`.
- `visualization_stats` + the prompt's *Choosing colors* rules: log scale (a setting), diverging
  maps centered with a `domain`, clipping domains; the legend marks clipped ends.

### Accounts and Supabase

- **Project** `rorqzjnwqwlyusagzcxy` (https://rorqzjnwqwlyusagzcxy.supabase.co). `client/supabase.ts`
  makes the one client; the URL and **publishable key** are committed (they ship in the bundle either
  way; the database's RLS guards the data). The session lives in localStorage `powergis.auth`.
- **Accounts** (`client/auth.ts`): a reactive `auth` (`ready`, `user`, `profile`, `recovering`) kept by
  `onAuthStateChange`, and actions that answer `null` or a message to show (Supabase's messages said
  plainly; failures also go to the debug log): `signUp` (confirmation email back to `here()` — the
  current site, production or a preview), `signIn`, `signOut`, `sendPasswordReset` (the link opens the
  app with `type=recovery`; `auth.recovering` opens *Choose a new password*), `setNewPassword`,
  `changePassword` (re-checks the current password with `signInWithPassword`, then `updateUser`),
  `updateDisplayName`, `deleteAccount` (re-checks the password, then `rpc('delete_my_account')` —
  `supabase/002_delete_account.sql`, security definer: deletes the datasets the caller owns, then
  `auth.users`, which cascades to profile, access rows and workspaces — then forgets the session
  locally; PR 3 adds removing owned datasets' files first). Account state is the client's own, like the assistant's API key; data still
  goes through the server's requests (PR 3 hands the worker the session's token).
- **Cloud workspace** (PR 2): the worker reaches Supabase as the signed-in user. `client/auth.ts` sends
  every new access token (`setAuth`; `null` on sign-out; replayed to a restarted worker with `init`),
  and the worker makes a `CloudStore` for it (`server/cloud.ts`; the interface is `shared/cloud.ts`, so
  tests use a fake; the project values are `shared/supabaseConfig.ts`, shared with the page). Requests:
  `cloudWorkspace` (the account's default workspace, any version), `saveCloudWorkspace({file, overview})`
  (the cloud row keeps `config` = the document and `overview` = `overviewOf(file)`, rewritten on every
  save; `supabase/003_workspace_overview.sql`) and `openDocument({file})` → `{file, missing, failed}`.
  - **Documents (v2, `lib/workspace/file.ts`)**: the setup plus `datasets`, the facts of every dataset
    pointed at (id, name, description, store, rows, `origin` builtin | output | upload | unknown, and
    `sameAs`: ids of the same dataset elsewhere). `toWorkspaceFile(doc, record)` builds one from this
    device's registry; Copy / Paste, Download / Load and the cloud all carry it. Version 1 documents
    (ids or `builtin:` / `transform:` placeholders, an optional `names` map) are read and converted.
  - **`openDocument`** (server; `seedDefaultWorkspace` uses it too), dataset by dataset: here by id,
    by `sameAs`, or by a copy that remembers it (`extensions.copyOf`) → used; a built-in → reused or
    uploaded; an output → its transform runs once all inputs are resolved (any order), unless a copy
    here was written by the same SQL (`extensions.sql`, recorded by every `runTransform`) — a stale
    copy is rewritten in place; anything else → `missing` with why (`elsewhere`, `cloud`, `unknown`,
    `builtin`, `output`). Copies record the ids they stand for, so the next open reuses them, on this
    device or after a round trip through another. `missingReport` words the result for the Workspace
    panel: datasets by name and why, transforms that couldn't run and why, and what waits on them.
  - **Unavailable items** (`lib/workspace/unavailable.ts`): opening never drops anything. A missing
    dataset stays in the working copy as `doc.unavailable[id]` — the document's facts plus why —
    saved with the workspace (`WorkspaceConfig.unavailable`; `saveWorkspace` accepts listed ids it
    marks unavailable) and in documents (`toWorkspaceFile` falls back to those facts), so a device
    missing data never erases it from the account's copy. `unavailability(doc, present)` gives the
    missing **roots** (nothing here can make them) and everything waiting on them, to a fixed point;
    a missing output whose transform can run isn't a root (Run makes it; Run all stale includes such
    transforms). The page marks them (graph: red outline, ⚠ on roots, "waits for …"; lists: a red
    line; the map skips them), a root opens in the dataset panel (`DatasetEditor.vue` with `missing`,
    on Replace's source choice when tapped in the graph) to be replaced by anything the add panel adds (`replaceDataset`: every pointer moves),
    then offers **Run them now** (`downstreamOrder`). Running a transform whose output pointed at a
    missing dataset writes a new one, which takes the old id's place. The Workspace panel shows the
    count with **Show in graph** and **Remove what didn't load** (`removeUnavailable`, a draft edit).
  - **Replace… on any dataset**: a **⇄ Replace…** button in the dataset panel,
    `DatasetEditor.vue`: the one panel for a dataset, here or missing (`missing`: the same Name / Description fields, read-only,
    then a red ⚠ line with why and what waits; `replaceOpen` when tapped in the graph). `DatasetList`'s Edit
    uses it and emits `replace(oldId, newId)`; a transform's output shows why it can't be replaced
    instead. The button opens the usual
    `AddDatasetPanel` (every source, `pickLabel` "Use"; only the replaced dataset is excluded from
    Saved); its Cancel closes it back to the button. `replaceDataset` moves every pointer (dataset list —
    no duplicate if the replacement is already listed —, transform inputs, visualizations) and refuses
    a replacement made downstream of the one it replaces; then **Run them now** as for missing ones.
    Schema isn't checked: a mismatch surfaces when a transform runs or a visualization queries.
  - **Only on this device** (signed in): `onlyOnThisDevice(doc, record)` — the workspace's uploads
    kept locally (not built-ins, not transform outputs, not cloud datasets). The Workspace panel
    lists them in a short scrolling box; Save adds a note that other devices and people you share
    with will see them as missing. Storing them in the cloud is the cloud-datasets PR.
  - **Page** (`MapPage.vue`): Save → `saveHere` (device) then `saveToCloud`. On load and on sign-in,
    `catchUpWithCloud`: no cloud workspace yet → this device's is saved there; one saved since this
    device last saw it (`powergis.cloudSeen` = `<user>:<updatedAt>`) → opened (`openDocument`, then
    saved here), asking first over unsaved changes. The Workspace panel says where changes are saved.
- **UI**: ☰ → **Sign in** / your name opens `components/account/AccountModal.vue` (sign in, create
  account, forgot password, choose a new password, your profile, delete account). Sign in and create
  account carry a plain note on what's kept without an account (this browser only; browsers may clear
  it on their own) and what an account adds (the option to store them in the cloud).
- **Schema** (`supabase/schema.sql`, run once in the SQL editor; later changes go in new files):
  - `profiles` (made by a trigger on sign-up; you read only your own),
  - `datasets` (registry: name, description, columns, row count, `meta`, `file_path`, `created_by`),
  - `dataset_access` (`dataset_id`, `user_id`, `access` owner | write | read, `granted_by`; one owner,
    made by a trigger with the dataset),
  - `workspaces` (`owner_id`, `name`, `config` = the `.powergis.json` JSON, `is_default`; one default
    per user),
  - a private storage bucket `datasets`, one file per dataset at `<dataset id>/data.parquet`.
- **Rules** (RLS; the app's role gets only explicit grants — new tables aren't exposed automatically):
  you see a dataset with any access; owners and writers change it and grant read or write; writers
  only raise read to write and remove readers; only the owner removes write, deletes the dataset or
  its file; anyone but the owner can leave. `access_level(ds)` (security definer) is the one check
  the policies share. Sharing looks people up one exact email at a time (`find_user_by_email`), so
  no one can list every user; `dataset_members(ds)` lists a dataset's people to its members.
- **Tested** against a local Postgres 16 with stand-ins for `auth` and `storage` (three users through
  grant / upgrade / refused downgrade / refused owner removal / file upload / delete). This sandbox
  can't reach supabase.co, so sign-in itself is tested on the preview.

### Buttons (`components/ui/UiButton.vue`)

One button component: `size` tag / compact / regular / large (font, height, radius scale together;
glyphs 1.35× the label since symbol glyphs draw small; icon-only buttons are square), `tone` by job
(neutral, primary, dataset, transform, viz, attention, ok, danger), `active` for toggles. Pills
(＋ Dataset, Visible / Hidden, ↻ Run all stale) are `tag`; the header's Workspace / Assistant and
small icon buttons `compact`; ⤢ and tool buttons `regular`.
- **Server gate**: `RequestMessage.caller` (`'user'` default, `'agent'`); `createServer`'s handlers get
  it and refuse an agent's writes to remote datasets.

## §5 — Composables

Vue reactive wrappers around data fetches. Example:

```typescript
// src/lib/useMyData.ts
export const useMyData = () => {
  const data = ref([])
  onMounted(async () => {
    data.value = await fetch(...)
  })
  return { data }
}
```

Use these in components to stay reactive without fetch boilerplate.

## §6 — Components

Organized by feature. Keep them thin — mostly templating, logic lives in `lib/` and composables.

```
src/components/
  HelpModal.vue      (provided)
  <FeatureA>.vue
  <FeatureB>.vue
```

## §7 — Build, Deploy & Conventions

**Local dev:** `npm run dev` (hot reload at http://localhost:5173)

**Build before commit:** `npm run build` (catches TS errors + template parse errors)

**Production and preview, both via Netlify** (see `netlify.toml`): `main` pushes build production; every other branch/PR gets its own Deploy Preview.

**PR build check:** `.github/workflows/ci.yml` runs `npm run build` on every PR — this is the `build` status check the branch ruleset requires. It doesn't deploy anything.

**Conventions:**
- Components: PascalCase, one per file
- Functions/vars: camelCase
- CSS: BEM or utility classes (avoid specificity wars)
- Types: keep in component file or `types/` folder

## §8 — PWA & Service Worker

`pwa.ts` handles:
- Service worker registration
- Auto-update on new deploys
- Offline detection
- Update available → reload prompt

`main.ts` bootstraps the Vue app + PWA setup.

Service worker is generated by Vite + `vite-plugin-pwa` (auto-configured).

## §9 — Glossary

- **SPA** — Single-Page App (no server-side rendering, runs entirely in the browser)
- **PWA** — Progressive Web App (works offline, installable like a native app)
- **Service Worker** — Background script that handles caching and network requests
- **Deploy Preview** — Netlify's term for a per-branch temporary deploy
- **Build ID** — Git commit SHA, shown in footer for debugging
- **Reload latest** — Force-refresh service worker cache and reload the page

---

**When you change architecture or add a major feature, update the relevant section above + the diagram.**

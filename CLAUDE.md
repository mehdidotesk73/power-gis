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

- **Controls** (left sidebar on desktop, below the map on phones; the Workspace button sits in the header): Find (any visualization's features),
  visualizations, datasets, transforms, style editors (scalar + vector), ArcGIS import/export.
- **Map** (MapLibre GL) with:
  - **Scalar layers** — color (constant / colormap / categorical), transparency (fixed / by
    field), fill pattern (none / all / by field).
  - **Vector layers** — arrows with direction from the vector, size from magnitude, plus color and
    transparency encodings.
  - **Hover tooltip**, **click → feature panel** (the visualizations' values plus the rows behind
    the feature), **legend**.
- **Default map**: a county socioeconomic score (income, education, health insurance, housing
  affordability) with area-weighted state averages, built like any user's map: built-in datasets (six
  ACS county tables + US counties / states polygons), ten SQL transforms in stages (clean → join →
  metrics → state averages → state map; 1e uses the spatial extension for county land area) and twelve
  visualizations (the county score shows first), from the **default folder** `defaults/socioeconomic/`.
  **Default folders** (`defaults/<folder>/`: `folder.json` listing its tables, their CSVs,
  `workspace.powergis.json`; `defaults/README.md`): the build ships only the one `defaults/active.json`
  points at — its tables are the built-ins, its workspace the default map. (The EIA utilities map it
  replaced was removed with its data; it may come back as a folder built in the app.)

The entire app is wrapped inside a header and footer. The header provides the app title, a **☰ menu** (outlined green while signed in, and its account item's ◉ green; **Sign in** / your name, which opens the account window — signing in closes it; Help, which opens the conceptual-docs modal, and on touch devices **Desktop view / Phone view**), and an "Update available" affordance that surfaces when a newer PWA build is live. The footer (one row, small type) provides the current build id/timestamp, version-check status against the live origin, a "Reload latest" button to force-refresh a stale cache, and a collapsible debug log with copy-to-clipboard support. See `docs/system-design.md` §2 for the full wrapper template and implementation details.

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
- **Cloud integration tests:** `tests/cloud/` (`npm run test:cloud`, kept out of `npm test`) run the real
  `server/cloud.ts` and server requests as several real accounts against a local Supabase stack
  (`eval "$(scripts/test-stack.sh)"`: `supabase start` via the npm `supabase` CLI, Docker, no account;
  our `supabase/*.sql` applied in order; `supabase/config.toml` is that local stack's config only).
  Builds can point at another project with `VITE_SUPABASE_URL` / `VITE_SUPABASE_KEY`.
- **UI tests:** `tests/e2e/` (Playwright, `npm run build:e2e` against the stack, then `npm run test:e2e`):
  the app in a browser, one context per device, two people: the socioeconomic fixture pipeline and
  the cloud scenarios (`tests/e2e/README.md`). Elements by **stable test keys** (`data-testid`: cards
  `<kind>-card` + `data-name`, menu items `menu.<action>`, nodes `node.<kind>`, …) — keep them when
  changing those controls, and add one to anything a new test touches.
- **CI runs build + tests on every PR** (`.github/workflows/ci.yml`, job `build`: build, unit and cloud
  integration tests, against the local stack), and the branch ruleset requires it to pass before merge.
  Required tests stay inside that one job — never a separate job, since the ruleset only watches `build`.
  **The one deliberate exception:** the UI tests run in a second job, `ui-tests`, which the ruleset
  doesn't watch — ✓ / ✗ on every PR, never blocking, while they prove steady. Tell the user whenever
  it goes red (a red non-blocking check is easy to ignore); after about 10 green runs in a row, move its
  steps back into `build` (`docs/TODO.md`).
- **External data dependencies:** the basemap (dark vector tiles, free, no key: OpenFreeMap dark, else CARTO Dark Matter, else a plain background).
  The app's own data is static (the default folder in `defaults/`).
  From this sandbox eia.gov and census.gov are blocked; the PUDL S3 bucket (EIA data) is reachable. You cannot
  see the rendered map here unless you drive a headless browser; lean on the user's screenshots.

## Data

- **ACS county tables** (the default map's data): built-in `county_income`, `county_education`
  (B15003), `county_health_insurance` (B27010), `county_home_value` (B25077, B25075), `county_rent`
  (B25064, B25063) and `county_columns` (what each column means), CSVs in `defaults/socioeconomic/` (3,222 counties
  incl. Puerto Rico; `GEOID` = county FIPS). The ACS uses Connecticut's nine planning regions, so its
  eight old counties in us-atlas get no values.
- **Boundary datasets**: built-in `us_counties` (`fips`, `name` "Autauga, AL", `county`, `state`,
  `state_fips`, `geometry`) and `us_states` (`fips`, `name`, `abbr`, `geometry`), made from the `us-atlas`
  npm package (Census 2017, 1:10m) by `lib/data/boundaryTables.ts` in the worker. Region codes in any
  dataset are joined onto them in a transform — there is no region-code binding. EIA-861 still
  reports Connecticut's eight legacy counties, which match us-atlas.
- **Built-ins** (`shared/builtins.ts`: the active default folder's `folder.json` tables; `DEFAULT_FOLDERS`
  has every folder's, and `createServer`'s `builtins` env takes another folder's in tests; `vite.config.ts`'s
  `default-folder` plugin serves / emits that folder's CSVs and workspace at `data/`): uploading one stores a
  copy marked `extensions.builtin = <table>` and `extensions.version`; **bump `version` (in `folder.json`)
  when a built-in's columns or contents change**,
  or devices keep reusing their old copy for the default map. **Data-agnostic code**: nothing outside the data files and the default workspace file
  knows what a utility or a county is.
- **Client / server boundary** (everything runs in the browser today, but split as if it didn't):
  - **Server** (`src/server/`): a **Web Worker** (`worker.ts`) running `createServer` (`server.ts`).
    It owns every **lasting change** and every **heavy computation**: uploads, dataset edits,
    visualization values, feature rows, saving workspaces. Answers are pointers (uuids) or small
    results, as `ApiResult` (`{ok, data}` / `{ok:false, error:{code,message}}`) — never throws.
  - **Contract** (`src/shared/`): `api.ts` (request types), `records.ts` (base tables), `database.ts`
    (`ReadDatabase` / `Database` + in-memory test DB), `idb.ts` (IndexedDB), `builtins.ts`.
  - **Client** (`src/client/`, components): `request(type, payload)` (`api.ts`) for anything that
    writes, computes or reads rows (`datasetRows` pages, `exportVisualization` files,
    `seedDefaultWorkspace`); `readDb` (`db.ts`, a `RecordReader`: records only, no rows) to read the
    registry. **Components never write the database or read data tables**, and fetch nothing but
    `version.json`; `src/client/boundary.test.ts` fails on a client import of server-only code
    (`server/`, `shared/idb`, `lib/arcgis`, `lib/data/*`, profiles) or a stray `fetch`. New features
    that change or read data add a request type, not client code.
- **Database** (IndexedDB `powergis-db` on this device; Supabase later). Base tables, every row with a
  uuid `id` + editable `name`, no access control yet: `users`, `workspaces` (config of **pointers**:
  `datasetIds`, ordered `visualizationIds`), `datasets` (registry: data table name, columns, row
  count, origin, description, `extensions`), `transforms` (SQL, inputs `{datasetId, alias}`, output
  id), `visualizations` (dataset id + settings). **Each dataset is its own data table**
  (`ds_<uuid>`). **Stores**: every dataset's rows are here; `storeOf(d)` is `remote` when it's linked to a cloud
  dataset (`DatasetRecord.link`), else `local`; **users see "Local" / "Cloud" (↑ ↓ ↑↓)** — same functions on both. Datasets carry standard metadata only — **source and usage policy are not dataset
  properties**.
- **Assistant (agents)** (`docs/agents.md`): **✦ Assistant** in the header opens a chat with the
  dataset processor agent (`components/agent/AgentPanel.vue`). The user's own Anthropic API key
  stays on the device (localStorage `powergis.anthropicKey`); calls go straight to Anthropic
  (`client/agent/claude.ts`, streaming; the model is picked in ⚙ from `CLAUDE_MODELS`, default
  `claude-haiku-5-5`, fixed for each chat). Provider-neutral loop and tools in
  `src/lib/agent/` (`provider.ts`, `loop.ts`, `tools.ts`, `prompt.ts`). On desktop the assistant is
  a column **docked on the right** of the page, resizable (`useSplitter`, `powergis.assistantWidth`;
  the left panel uses the same composable); on phones a sheet. Screenshots paste or attach (📎),
  shrunk before sending (`agent/images.ts`). Tools act through an
  `AgentHost` the page supplies (`agentHost` in `MapPage.vue`): the same functions as the UI. The
  agent starts from the workspace (`get_workspace`: its datasets' names, descriptions, stores),
  edits it as **files** with Anthropic's text editor tool (`str_replace_based_edit_tool`, run by us on
  a staged copy: `workspace.json` index, `datasets.json` (name / description editable; store, rows,
  origin read-only), `transforms/<id>.json` + `<id>.<key>.sql`,
  `visualizations/<id>.json`, generated `overview.md`; SQL never inside JSON) and commits with
  `apply_workspace` (checks everything, returns new ids; `lib/agent/workspaceFiles.ts`). Everything
  existing is targeted by id. Our tools are `strict`. It confirms plans with `ask_user` (an Approve / Reject card with notes in the chat), and looks beyond
  the workspace only with the user's OK, through `list_datasets`, which reads the app's one
  **dataset finder** (`listDatasets()`, `client/datasets.ts`: local today, + the remote registry
  later); the prompt names no datasets. Agents
  change this device's copies only (a linked one turns ↑) and never sync: the server refuses
  `caller: 'agent'` on every link / push / pull request (`request(type, payload, 'agent')`).
- **Accounts (Supabase)**: project `rorqzjnwqwlyusagzcxy`; `client/supabase.ts` (URL + publishable
  key, committed — public by design), `client/auth.ts` (reactive `auth`; sign up / in / out, reset
  and change password, display name, delete account via `rpc('delete_my_account')`; actions answer
  `null` or a message), `components/account/
  AccountModal.vue` (☰ → Sign in / your name). The whole schema is `supabase/schema.sql` (profiles,
  datasets registry, `dataset_access` owner | write | read, `workspaces` one default per user, a
  private `datasets` bucket of `<id>/data.parquet`; RLS everywhere, explicit grants). Schema changes
  go in **new** SQL files for the user to run, never edits to the one already run. This sandbox can't
  reach supabase.co: test against the local stack (`scripts/test-stack.sh`: the real schema, Auth, REST,
  Storage; start `dockerd` first, and set `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`), and a
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_KEY` build of the app against it drives the UI as several users
  (Playwright, one browser context per device). **Cloud workspace**: the worker talks to Supabase as the user (`setAuth`
  token → `server/cloud.ts`, a `CloudStore` from `shared/cloud.ts`; tests use a fake); Save also sends
  the workspace **document** (+ `overviewOf` text) and the page opens a newer one on load / sign-in
  (`catchUpWithCloud` → `openDocument`) — unless this device's last save didn't reach the account
  (`powergis.cloudPending`): then it sends that one up instead. Every request that may reach the cloud
  first re-sends the session's current token (`onBeforeCloud` in `client/api.ts` → `syncCloudAuth`): the
  worker's copy went stale or missing on iOS and read as signed out. **Cloud links** (manual sync): the app only ever works on **local copies**;
  a dataset is local only, or **linked** (`DatasetRecord.link` = `{cloudId, version, changed?}`: its cloud
  dataset, the version it last matched, changed here since). Nothing reaches the cloud but the user's
  syncs, never an agent: requests `linkToCloud` (first push; the cloud id is the dataset's own id when
  free), `pushDataset` (`conflict` when the cloud moved on, unless `overwrite`), `pullDataset` (also makes
  a copy under the document's id with `cloudId`), `unlinkDataset`, `deleteFromCloud` (owner), `cloudStatus`
  (state `synced` / `ahead` ↑ / `behind` ↓ / `both` ↑↓ / `gone`, and `canPush`: owner or write). Push for
  owner / write, pull for everyone. A transform run, rename or description marks a linked copy ↑. Rows
  travel as `<cloudId>/data.arrow.gz` (`server/datasetFile.ts`: gzip Arrow IPC, read without DuckDB —
  Parquet needs a DuckDB extension download). The page checks states on load and every minute
  (`checkCloud`). Every sync goes through the **review panel** (`dataset/BatchPanel.vue`): the same
  buttons on every line (**Push · Pull · Skip**, or **Link · Skip**), the ones that don't apply disabled
  with the reason; ↑↓ starts as Skip. Workspace panel: **Link to cloud…** (uploads only here), **Sync
  all…** (linked ones not in sync). `openDocument` pulls linked datasets this device lacks (outputs too)
  under the document's ids; ones already here keep their copy. Built-ins are never linked. 50 MB a file
  (`MAX_CLOUD_FILE`). Later: auto-sync, live transforms. **Sharing**: a linked dataset's **Share…**
  (`dataset/SharePanel.vue`; requests `datasetMembers`, `shareDataset` by email, `setMemberAccess`,
  `removeMember` — your own = Leave, which unlinks this copy); `canManage` / `canShare` in
  `shared/cloud.ts` mirror the RLS rules (the server checks them first; RLS skips forbidden rows
  silently). Recipients add it from **＋ Dataset → Cloud** (`cloudDatasets`, `addFromCloud`: a linked
  copy). The agent's `list_datasets` stays local.
- **Concepts — keep the names straight:**
  - **Connector** (`src/lib/data/connectors.ts`): how the server reads a source (built-in CSVs,
    device files, in-memory tables, ArcGIS features via `featureTable`).
  - **Dataset**: a plain table in the database, by id. No geometry of its own.
  - **Visualization** (`src/lib/dataset/visualization.ts`): a dataset pointer plus settings —
    **geometry binding** (`{kind: 'geometry', column, label?}`: a geometry column, plus an optional
    column naming each feature), column, `Aggregation`, style. **No lat/lon pairs, no region codes**:
    a visualization draws real features. The server groups rows onto features (identical geometries
    → one feature) and aggregates (`lib/dataset/query.ts`, cached per dataset+binding), sending each
    feature's geometry. Any number per dataset; one ordered list.
    **Top of the list draws on top** (within its geometry kind): widgets register their map layers
    in `ctx.stacks` and `MapView.restack` moves them to match. Restyling never refetches values.
- **Workspace** (`src/lib/workspace/workspace.ts`): the client's working copy (dataset pointers +
  ordered visualizations); **every edit is an operation** returning `{ok, doc}` or
  `{ok:false, error}` — the UI uses them and agents will too. **Explicit Save**: edits are a
  draft — dataset names / descriptions too (`doc.datasetEdits`, shown over the records via `withEdits`;
  Save writes them with `updateDataset` before saving the workspace) (localStorage `powergis.draft`, restored on reload, "Unsaved changes" + Discard in
  `WorkspaceBar` — the **Workspace** button in the header, teleported there from `MapPage` into
  `#header-workspace`; amber with a ● while unsaved; it drops down the name, counts, Save / Discard and
  the file actions) until Save sends `saveWorkspace`. **Workspace files** (`lib/workspace/file.ts`):
  download / load a `.powergis.json` of pointers + settings, never rows (or Copy / Paste the same JSON
  via the clipboard; Paste opens a box filled from the clipboard); loading replaces the
  working copy (fresh visualization ids, datasets missing from the database dropped and reported).
  Details: `docs/system-design.md` §4.
- **Vector is a primitive type** (`schema.ts`: `{u, v}` = east, north). A visualization's kind follows its
  column: vector columns → arrows, everything else → scalar (color / transparency / pattern).
  Vectors are read from `[u, v]`, `(u, v)`, `u,v`, `{"u":…,"v":…}` cells (combining two numeric
  columns into one is a transform's job: `vector(u, v)`). They aggregate component-wise (sum / mean).
  ArcGIS has no vector type, so exports split them into `<name>_u` / `<name>_v` Double fields;
  our schema sidecar rebuilds them on re-import.
- **Categorical colors** (`lib/palettes.ts`): every value gets a color — no category cap. Palettes
  `p12` / `p24` / `p60` are fixed, nested lists (each extends the smaller, starting from Tableau 10)
  that repeat when values outnumber them; `many` makes lightness variations of the 12 hues for any
  count; `auto` (default) picks the smallest that fits. Values are colored in sorted order, so a
  value keeps its color as data changes. Use `paletteColors(name, n)` for any widget (charts too).
- **Geometry columns** are column types — `point`, `polyline`, `region` (closed polylines) —
  holding GeoJSON geometries in lon/lat (WGS84); cells may arrive as GeoJSON or WKT and are coerced.
  Geometry comes with the data: GeoJSON / Esri / ArcGIS features get a typed geometry column, and
  CSV cells in WKT or GeoJSON are typed too. A table with only latitude / longitude columns has no
  geometry until a transform builds a point column (`point(lat, lon)`) — nothing is derived at upload.
- **Transforms** (SQL that makes datasets): DuckDB-WASM runs in the server worker, loaded on first use
  (`server/duckdb.ts`; the ~34 MB eh wasm is kept out of the PWA precache). `server/sql.ts` keeps
  **one engine copy per dataset** (`__ds_…`, reloaded only when its `updatedAt` changes, least recently
  used copies dropped past `CELL_BUDGET`), bulk-loaded as an Arrow IPC stream (`server/arrowStage.ts`;
  ~0.5 s for 3,071 × 330, was ~11 s as INSERT … VALUES); each query's aliases are temp views onto those
  copies, queries run one at a time; runs one SELECT (paged ones once, with `count(*) OVER ()`), and types the result again (GeoJSON text → geometry, `{u, v}` →
  vector). Helpers in SQL: `point(lat, lon)`, `vector(u, v)`. **Extensions** (allowlist
  `shared/sqlExtensions.json`, today only `spatial`): a query that needs one loads it and retries;
  GEOMETRY results come back as GeoJSON; a run records what the SQL used (`transform.requires`), and a
  workspace's are loaded ahead on open and saved in its files. The Netlify build hosts the extension
  files (`scripts/fetch-duckdb-extensions.mjs` → `public/duckdb-ext/`, git-ignored); otherwise they
  come from `extensions.duckdb.org`. Bump `duckdbVersion` there when upgrading DuckDB-WASM (a test checks). A transform is **inputs + outputs**:
  `TransformSpec {id, name, inputs, outputs: {key, name, sql, outputId?}[]}` — one SELECT per output.
  Requests: `previewTransform` (one SQL's first rows, nothing stored), `runTransform` (runs every
  output's SQL, then — only if all succeed — writes each into its `outputId` or a new dataset named
  after the output; returns `{outputs: [{key, datasetId, rowCount, created}], requires}`). Older single-SQL
  transforms (`sql` + `outputId`) are read through `normalizeTransform` (drafts, files, records).
  Transforms are part of the workspace draft (ops `addTransform` / `updateTransform` /
  `removeTransform`) and saved with it. The editor sets inputs and outputs first — **one compact line each**
  (input: dataset chip · `as` alias · ⤵ Insert · ⇄ change · ✕; output: ▤ · name · → writes to · ✕) —
  then one SQL per output; Run writes them all. A **preview dock** at the editor's bottom (sticky,
  collapsible) shows one thing at a time: tap an input chip for its first rows (read from the
  database), an output's ▤ (or its SQL's **Preview ↓**) for what its SQL would write. Inputs are `{datasetId, alias}` pairs: the dataset is picked
  in a search box (name, typo-tolerant, or a pasted id — a dataset's hold menu → Copy id); the alias is the
  table name in the SQL (Insert puts it at the cursor; renaming it renames it in the SQL; an unknown
  table's error lists the aliases). Tests run real DuckDB through its Node build
  (`server/testEngine.ts`). Every written data table gets a **profile** (`lib/dataset/profile.ts`).
- **Side panel**: resizable on desktop (splitter, `--panel-w`, `powergis.panelWidth`; `MapView` resizes
  the map with a `ResizeObserver`). **Two modes** (`mode` in `MapPage.vue`; one map, the same components
  moved by CSS grid areas, so nothing is lost on switching): **explore** puts the map first — Find
  ("Search within … over …") above it and Export below it in the map column; desktop keeps the side panel
  on the left (List | Graph | ⤢, then List | Graph, then what you open, scrolling together in `.panel-body`:
  phone setup without the mini map), phones hide it behind a vertical **Set up** bar left of the search (the legend is always
  top-left of the map; Export's body scrolls inside at most 45% of the column). The app is one screen tall (`App.vue`: `.app` 100dvh flex column, `.content` fills what
  header and footer leave); only panels scroll. **Setup** (⤢ on desktop, the
  dock on phones; ✕ or Esc back) makes the page one panel headed by the **List | Graph | ✕** row
  (`.view-row`, its own grid area `head`, spanning the page; `.panel-body` turns `display: contents` so
  its parts take their own areas). What you open — the graph's open item, list
  editors (dataset / transform / visualization) and Explore — teleports into its own section
  (`#setup-detail`; `components/detailTarget.ts`: `provideDetailTarget` / `useDetailTarget`). Desktop: two
  columns, List | Graph over a **mini map** on the left, that section on the right. Phones: List | Graph,
  then that section, scrolling together (the page scrolls, head sticky) above a mini map anchored at the
  bottom (sticky; `scroll-padding` keeps revealed items clear of both). The mini map's height is dragged
  from the bar above it on both (`useSplitter` with `side: 'bottom'`, `--minimap-h`, `powergis.minimapHeight`). **New-item flows scroll each step
  into view** with `v-reveal` (`components/reveal.ts`): use it on any form or step a flow opens.
- **Explore** (`dataset/ExploreModal.vue`, a dataset's menu): a window with a SQL box (starts
  `SELECT * FROM <dataset>`) over a docked results table, **200 rows a page** (Prev / Next) with the
  total count — `previewTransform` with `limit` + `offset`, nothing stored. Every workspace dataset
  is usable by its table name (chips insert it); only tables the SQL names are loaded. Ctrl/⌘+Enter runs.
- **Find** (`FindPanel.vue`, a separate compact card **docked** at the top of the side panel —
  `position: sticky` — "Search in [viz] in [All data / column]"; smaller text with a mouse, 16px on touch): pick a visualization, then search — all data or one column — over its
  features' names and every text value in their rows (typo-tolerant). The server builds the index
  (`findIndex` request, `lib/dataset/query.ts`, cached with the grouping; columns with more than
  20k distinct values are left out); `findFeatures` returns the matching features' keys, which the
  page highlights (on every visualization drawing the same features) and zooms to.
- Column types are inferred (`inferColumns`); zero-padded codes stay text.
- **Draw order** follows geometry, not add order: regions → lines → points → arrows, all above the
  basemap's roads and borders and under its labels (invisible slot layers added in `MapView` before
  the trailing run of symbol layers; labels repainted light with a dark halo).
- **Workspace documents (format v2, `lib/workspace/file.ts`)**: what Copy / Paste, Download / Load,
  the cloud and the default map carry — the setup (dataset pointers, transforms with SQL,
  visualizations with all settings) plus **facts for every dataset pointed at** (`datasets`: id, name,
  description, store, rows, `origin` builtin | output | upload | unknown, `sameAs`), never rows.
  `toWorkspaceFile(doc, record)` makes one; `parseWorkspaceFile` validates (v1 is read and converted);
  **`openDocument`** (server) makes ids real on this device: present (by id, `sameAs`, or a copy's
  `extensions.copyOf`) → used; built-in → reused or uploaded; output → reused if a copy's
  `extensions.sql` matches, else the transform runs (into that copy), in dependency order; else
  `missing` with why — `missingReport` words it for the Workspace panel. **Nothing is dropped**: a
  missing dataset stays in the working copy as `doc.unavailable[id]` (its facts + why; saved in the
  workspace record's `config.unavailable` and in documents), and `lib/workspace/unavailable.ts`
  works out the rest — `unavailability(doc, present)` (missing roots, and the datasets / transforms /
  visualizations waiting on them), `replaceDataset` (the replacement takes over every pointer),
  `removeUnavailable`, `downstreamOrder`. UI: red outlines in the graph (⚠ on roots, "waits for …"),
  red lines in the lists, nothing drawn on the map; a root opens in the same
  dataset panel as any dataset (`dataset/DatasetEditor.vue` with `missing`: the same Name / Description, read-only, then a
  red ⚠ line with why and what waits), on Replace's source choice when tapped in the graph (`replaceOpen`), then **Run them now**; the Workspace panel offers **Show in
  graph** and **Remove what didn't load**. Run all stale also re-makes outputs missing here.
  **Replace… on any dataset** (Edit → **⇄ Replace…**, in `DatasetEditor.vue`, the one dataset
  panel: the button opens the usual add-dataset panel, Cancel closes it): the replacement takes over every pointer (`replaceDataset`, refused when
  the replacement is made from the one it replaces), a draft until Save; a transform's output can't
  be replaced (its transform would overwrite it). Signed in, the Workspace panel lists uploads
  **only on this device** (`onlyOnThisDevice`: not built-ins, outputs or cloud ones) in a short
  scrolling box, and Save notes them. Every transform output
  records the SQL that wrote it (`extensions.sql`). Agreed next: the same content as the agent's files
  (+ full visualization settings) and a zip for Download / Load (`docs/TODO.md`).
- **Default workspace** (the active folder's `workspace.powergis.json`, served at `data/`): a v2 document with readable ids
  (`default-county-income`, …, outputs like `default-county-metrics-and-scores`, transforms `default-t-…`).
  Its spatial step makes a first visit also download DuckDB's spatial extension (~23 MB). `seedDefault` (`MapPage.vue`)
  asks the server (`seedDefaultWorkspace` → `openDocument`; the first run loads DuckDB) and opens the
  result like a loaded document. Changing the default map = editing that file, or pointing `defaults/active.json` at another folder. Every dataset's click panel shows its rows (`FeatureRows`).
- **Object lists** (`components/list/ObjectList.vue`, generic over the item type): datasets,
  visualizations and transforms are cards in one widget, like an object table configuration — the
  page passes `items`, `itemKey`, the card body (default slot) and `actions(item)` (the hold menu:
  `{id, label, icon, danger, disabled}`), and handles `@action(id, item)`. No buttons on the cards:
  **tap and hold** (right-click with a mouse; `useLongPress`, pointer events + timer since iOS fires
  no `contextmenu`; moving > 10 px cancels) opens the menu — teleported to `<body>`, `position:
  fixed` at the press point and nudged on screen, so scrolling panels / the pop-out can't clip it
  (scrolling closes it). `reorderable` adds **Reorder** (before the
  first danger action): ≡ handles on every card, vertically centered, until **Done**
  (`useDragReorder`: pointer events, not HTML5 drag-and-drop which iOS lacks; moves and the release
  are also heard on the window, since moving a row in the DOM can drop pointer capture on iOS and
  leave it looking dragged). Cards set `-webkit-touch-callout: none` / `user-select: none` (inputs,
  textareas and tables inside stay selectable) and `touch-action: pan-y`.
  Menus: datasets — Explore, Edit, Copy id, Link to cloud (linked: Sync…, Share…, Unlink from the cloud),
  Reorder, Remove from workspace, Delete dataset (this device's copy), Delete from the cloud (linked); visualizations
  (a **Visible / Hidden pill** on the card toggles — only a tap on the pill itself) — Edit, Zoom to
  data, Reorder, Delete; transforms — Preview, Run, Edit, Delete. **Double-click / double-tap a card**
  (`useDoubleTap`: two clicks on one card within 350 ms; not on buttons, fields or `[data-no-open]`
  editors) opens it: a dataset's Explore, a transform's or visualization's editor (`@open`). **Cards only** —
  graph nodes stay tap = select / tap again = deselect (a double-tap there raced the card's layout shift).
- **List view** panels (Visualizations, Transforms, Datasets, then Export) open collapsed; each
  panel's ＋ button sits at its top. All ＋ buttons (graph and lists) are the global `.kind-pill`
  (`k-dataset` / `k-transform` / `k-viz`, in `vars.css`).
- **Graph view (DAG)** — the default view; a **List | Graph** switch above the panels changes it,
  remembered per device (`powergis.controlsView`). `lib/workspace/dag.ts` `buildDag(doc, dataset)` turns the workspace into
  nodes (`ds:` / `tr:` / `viz:` keys) and edges; rows by depth (a transform one row below its deepest
  input, its output below it, every visualization in the bottom row); `orderLayers` minimizes arrow
  crossings (virtual points for row-skipping edges, `edge.via`; barycenter sweeps + swaps);
  `layoutDag(dag, 'vertical' | 'horizontal')` places them and `edgePath` draws edges (automatic;
  only the ↓ / → direction is remembered per device, `powergis.dagDirection`). The graph **pans and
  zooms** (`dag/usePanZoom.ts` + `lib/panZoom.ts`): drag; Shift + wheel or pinch; on phones
  touch-and-hold then drag, two-finger pinch (one finger still scrolls the page). Opens fitted. **⧉ Copy as image** (in the zoom buttons): `dag/graphImage.ts` draws what the window shows (pan + zoom) on a canvas from the layout and page tokens (no DOM screenshot), at 2× or more; the clipboard write starts inside the tap with the PNG still being drawn (iOS), else it downloads `graph.png`. Dataset nodes carry a **store dot** before DATASET (violet = cloud, gray = this device; a yellow
  ring = an output out of date or not made yet: `DagNode.store` / `pending`). Transforms show **not run yet** (no
  output) or **needs re-run** (an input's `updatedAt` is newer than the output's; `transformState`).
  **↻ Run all stale** (graph toolbar + list Transforms panel, only when there's something to run) runs
  `staleRunOrder`: every stale transform plus everything downstream of one, inputs first, stopping at
  the first failure; never-run transforms are skipped. `DagView.vue`
  draws it (nodes are buttons, edges one SVG); **tap** a node to show its card under the graph — the
  same list components filtered to that item (`compact`) — and **hold** the card for its menu, as in
  the lists (only new transforms / visualizations open straight into their editors).
  **＋ Dataset**: the add-dataset form under the graph (the new dataset's node then opens);
  **＋ Transform**: tap input datasets, Next → a new transform with those inputs; **＋ Visualization**:
  tap a dataset → the add form. The graph is an interface to the same workspace operations, not a
  separate model.
- **One writer per dataset.** Each output writes a new dataset (made on Run) or an existing one that
  no other output (of any transform) writes and that isn't one of its transform's inputs
  (`checkTransform`).
  Deleting a transform keeps its output dataset — it just can't be re-run until another transform
  is set to write it. Transform menu: Preview (first rows, without opening the editor), Run, Edit,
  Delete.
- County join keys are 5-digit FIPS strings (`county_fips` / `fips`). Keep them strings: leading
  zeros matter.

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
    data/connectors.ts     connectors: how sources are read
    data/boundaryTables.ts us-atlas → us_counties / us_states rows (built-in boundary datasets)
    workspace/             the client's working copy + operations (workspace.ts), files + drafts (file.ts), graph (dag.ts)
    dataset/               columns, aggregate, binding (+ wkt), query (server-side grouping), profile, visualization
    search.ts              ranked type-ahead search (optional typo-tolerant `fuzzy`)
    data/csv.ts            CSV → records
  shared/                  client ↔ server contract: api, records (tables), database, idb, builtins, sqlExtensions (+ .json allowlist)
  server/                  the server (Web Worker today): server.ts handlers, worker.ts entry, sql.ts + duckdb.ts (transforms)
  client/                  api.ts (requests to the server), db.ts (read-only database), agent/claude.ts (Anthropic adapter),
                           supabase.ts + auth.ts (the Supabase client; the signed-in account)
  lib/agent/               agent: provider contract, loop, tools (+ store gate), prompt
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
    list/                  ObjectList.vue (cards + hold menu + reorder), useLongPress, useDragReorder
    dag/DagView.vue        the workspace graph: datasets → transforms → outputs → visualizations
    FindPanel.vue          Find: search a visualization's features by name or any text value
    MapPage.vue            the page (a client): workspace copy, server values → map widgets, panels, legend
    dataset/            AddDatasetPanel (+ Cloud source), DatasetList, BatchPanel (sync review), SharePanel, DatasetEditor (the dataset panel, missing ones too), VisualizationList, VisualizationEditor, BindingEditor, FeatureRows
    workspace/WorkspaceBar.vue  name, Save / Discard, file download / load, reset
    transform/TransformsPanel.vue  transforms: inputs, SQL, Preview, Run
    HelpModal.vue          renders docs/concepts/*.md into the Help modal
    agent/AgentPanel.vue   the assistant chat (API key, messages, tool steps, Stop)
    account/AccountModal.vue  sign in / create account / reset password / your profile
defaults/                  default folders: active.json (the one this build ships), README.md;
  socioeconomic/           folder.json, county_*.csv (ACS), workspace.powergis.json (the default map)
supabase/                  schema.sql (the Supabase schema + RLS) and later NNN_*.sql changes, each run once in the SQL editor;
                           config.toml (the local test stack only)
tests/cloud/               cloud integration tests (real Supabase stack); tests/e2e/ UI tests (Playwright);
                           tests/fixtures/ workspace files (socioeconomic with uploads, state-income, counties-only, utilities-join)
scripts/                   fetch-duckdb-extensions.mjs (prebuild, Netlify only); test-stack.sh (local Supabase for tests)
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
  then visualizations of it via the ops. No dataset-specific code: a new built-in is a table in the
  default folder's `folder.json` (+ its CSV); a new default view is an edit to its workspace file, or a
  new folder.
- **MapLibre flattens nested properties** into JSON strings in rendered features. Widgets emit only
  feature ids; look the original feature up by id (see `byKey` in `MapPage.vue`).
- **Patterns are a region encoding** (fill-pattern). Points/polylines ignore `style.pattern`.
- **Vector direction convention:** degrees clockwise from north, pointing where the vector goes;
  `u` = east component, `v` = north component.
- **ArcGIS type mapping** is in `src/lib/arcgis.ts`'s header comment. Composite types travel as JSON
  strings in Esri fields; our full schema rides along under the `x-powergis` key.
- **Buttons are `UiButton`** (`components/ui/UiButton.vue`): `size` tag (pills: ＋ Dataset, Visible /
  Hidden) / compact (header controls, small icons) / regular (default; ⤢, tool buttons) / large;
  `tone` neutral / primary / dataset / transform / viz / attention / ok / danger; `icon` (a glyph,
  drawn 1.35× the label; icon only = square, give it an aria-label); `active` for toggles. Label
  and glyph scale with the size, padding stays tight. Use it for new buttons; older text `.btn`
  buttons are being moved over (`docs/TODO.md`, component audit).
- **Dark only, colours by job** (`src/styles/vars.css`, table in `docs/system-design.md` §2): blue =
  interaction only; violet = datasets, orange = transforms, green = visualizations / success; amber =
  needs attention, always with a mark (↻, ●, ⚠); red = errors. Components use tokens, never literals;
  map colours (MapLibre can't read CSS variables) live in `lib/mapTheme.ts` (orchid Search matches).
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
- `docs/agents.md` — the agent design: tools, the local / remote store gate, workflow, runtime.
- `docs/concepts/*.md` — per-page user docs, also rendered into the Help modal.

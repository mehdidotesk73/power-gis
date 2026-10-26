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

Uses CSS custom properties (`--bg-elev`, `--text`, `--border`, etc.) for theming. Dark/light mode via `prefers-color-scheme` media query. Mobile-safe padding with `safe-area-inset` for notch/bottom-bar devices.

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
  ArcGIS URL, built-in table → new data table + registry row), `addColumn` (point from lat/lon or vector from east/north), `updateDataset`,
  `deleteDataset` (cleans up visualizations and workspace configs), `describeBinding` (features,
  unmatched rows, defaults), `queryVisualization` (one value per feature), `featureRows`,
  `saveWorkspace` (upserts its visualization records, deletes dropped ones), `deleteWorkspace`.
  Every answer is an `ApiResult`; errors carry `not_found` / `invalid` / `failed` / `unsupported`.
  Grouping a table onto features (`lib/dataset/query.ts`) is cached per dataset + binding and
  dropped when the dataset changes.
- **Client** — `src/client/api.ts` `request(type, payload)` posts to the worker (unwrapping Vue
  proxies, which can't be cloned); `src/client/db.ts` `readDb` is a `ReadDatabase`.
- **Database** — `src/shared/records.ts`. Base tables `users`, `workspaces`, `datasets`,
  `transforms`, `visualizations`: every record has a uuid `id`, an editable `name`, created/updated.
  A workspace's `config` holds only pointers (`datasetIds`, ordered `visualizationIds`). Each
  dataset's rows are their own data table (`ds_<uuid>`). IndexedDB (`shared/idb.ts`, database
  `powergis-db`: one store per base table + `data`) on this device; `MemoryDatabase` for tests. No
  access control yet — an access layer between users and tables comes later.
- **Geometry columns.** `point`, `polyline` and `region` are column types (`lib/dataset/columns.ts`):
  GeoJSON geometries in lon/lat, inferred from GeoJSON or WKT cells (a mixed column takes its most
  common kind; cells of another kind coerce to null). `uploadDataset` sets geometry up at ingestion:
  features get a typed geometry column, and a table with no geometry but an obvious lat/lon pair
  gets a `location` point column. `addColumn` derives a point (lat, lon) or a vector (east, north)
  column later.
- **Geometry binding is a visualization setting** — `{kind: 'geometry', column}` draws a geometry
  column; rows with identical geometry become one feature. There are no lat/lon bindings: a
  visualization always draws real features (older saved lat/lon visualizations are dropped on load
  with a log line, `isSupportedBinding`). The stopgap `{kind: 'boundary'}` matches region codes to
  built-in county / state polygons (static client files, `lib/dataset/boundaries.ts`, also loaded by
  the server to match codes) until transforms can join a boundary dataset. For geometry bindings the
  server sends the geometry; for boundary ones the client attaches it.
- **Not dataset properties:** source and usage policy — they belong to the agent workflow's run
  records (roadmap step 6).

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
- **Reset** replaces the copy with the default utilities map (a draft; datasets stay in the database).
- On open it calls `init`, opens the last-used (or newest) workspace, or seeds and saves one with the
  built-in utilities dataset (reused if already uploaded). Visualization values are fetched per
  (dataset, binding, column, aggregation) and cached; restyling never refetches.

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

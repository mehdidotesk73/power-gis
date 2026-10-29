# Default folders

Each folder here is a complete starting map: the data it needs and the workspace that uses it. The
app ships **one** of them, the one `active.json` points at:

```json
{ "folder": "socioeconomic" }
```

That folder's tables are the app's **built-ins** (＋ Dataset → Built-in) and its workspace is the
**default map** a first visit opens (and Workspace → Reset). Other folders' files aren't in the build.

A folder holds:

- `folder.json`: its name, a description, and its tables. Each table has a `table` name, a `label`
  and `description` (what the app shows), a `source` and a `version`:
  - `csv`: rows from `<table>.csv` in this folder;
  - `boundary`: polygons the app makes from the `us-atlas` package (`us_counties`, `us_states`).
  Bump `version` when a table's columns or contents change, or devices keep reusing their old copy.
- `<table>.csv` for every `csv` table (and no other CSVs).
- `workspace.powergis.json`: the default map, a workspace document (format v2) whose datasets are
  this folder's tables (`origin: { kind: 'builtin', table }`) and the transforms' outputs.

Folders today:

- `socioeconomic` (active): six Census ACS county tables + county and state shapes; ten transforms
  score every county 0–100 and average the states.

(The EIA-861 utilities map, the default until 2026-10-29, was removed with its data; it can come back
as a folder built in the app.)

To switch the default map, change `active.json` (a test checks it names a folder). To add one, make a
folder with the three kinds of file above: `src/lib/workspace/file.test.ts` checks every folder
(tables and CSVs match, the workspace's built-ins are the folder's, every transform is wired).

How it ships: `vite.config.ts`'s `default-folder` plugin serves the active folder's CSVs and
workspace at `data/` in development and copies them into the build's `data/`;
`src/shared/builtins.ts` reads every `folder.json` and takes the active one's tables.

# Default folders

Each folder here is a complete starting map: the data it needs and the workspace that uses it. The
app ships **one** of them, the one `active.json` points at:

```json
{ "folder": "socioeconomic" }
```

That folder's tables are the app's **samples** (＋ Dataset → Samples) and its workspace is the
**default map** a first visit opens (and Workspace → Reset). Other folders' files aren't in the build.
The geographic **built-ins** (US states, US counties) aren't in a folder: they're in `builtins/`, in every build,
and any folder's workspace can use them. The assistant sees the built-ins but not the samples (until the user
adds one).

A folder holds:

- `folder.json`: its name, a description, and its `samples`. Each has a `table` name, a `label` and
  `description` (what the app shows) and a `version`; its rows are `<table>.csv` in this folder. Bump
  `version` when a sample's columns or contents change, or devices keep reusing their old copy.
- `<table>.csv` for every sample (and no other CSVs).
- `workspace.powergis.json`: the default map, a workspace document (format v2) whose datasets are
  this folder's samples and the built-ins (`origin: { kind: 'builtin', table }`) and the transforms' outputs.

Folders today:

- `socioeconomic` (active): six Census ACS county samples (with the county and state built-ins); ten transforms
  score every county 0–100 and average the states.

(The EIA-861 utilities map, the default until 2026-10-29, was removed with its data; it can come back
as a folder built in the app.)

To switch the default map, change `active.json` (a test checks it names a folder). To add one, make a
folder with the three kinds of file above: `src/lib/workspace/file.test.ts` checks every folder
(samples and CSVs match, the workspace's tables are the folder's samples or built-ins, every transform is wired).

How it ships: `vite.config.ts`'s `default-folder` plugin serves the active folder's CSVs and
workspace at `data/` in development and copies them into the build's `data/`;
`src/shared/builtins.ts` reads every `folder.json` and takes the active one's samples, and `builtins/builtins.json`.

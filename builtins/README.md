# Built-in datasets

The geographic tables every PowerGIS build ships, in `builtins.json`: **US states** and **US counties**
(polygons the app makes from the `us-atlas` npm package: Census 2017, 1:10m; see
`src/lib/data/boundaryTables.ts`). They're offered under ＋ Dataset → Built-in, and the assistant may add
them (`add_builtin`) to put data on a map.

Each entry has a `table` name, a `label` and `description` (what the app shows) and a `version`. Bump
`version` when a table's columns or contents change, or devices keep reusing their old copy.

Example data (the ACS county tables) isn't built in: it's **samples**, in the default folders
(`defaults/`).

# UI tests

The built app in a real browser (Playwright, Chromium), against a local Supabase stack, clicking and
typing through the same controls a person uses. Each "device" is its own browser context (its own
storage), at phone or laptop size, so one test can be two people on three devices.

- `pipeline.spec.ts`: the socioeconomic pipeline: as the **default map** (a fresh device opens it;
  every output's rows, invariants and a sample via Explore), and as a file whose tables are uploads
  (`tests/fixtures/socioeconomic.powergis.json`: load, replace the six missing uploads with their CSVs
  from `defaults/socioeconomic/`, Run all stale). Needs DuckDB's spatial extension, which the CI build hosts.
- `workspace.spec.ts`: Download makes a `.powergis.zip`; Load on a fresh device opens the same workspace. And the
  user's phone check: download, change, download, Discard; Copy, Load the second zip, Paste the first back.
- `graph.spec.ts`: Copy graph as image puts a PNG of the graph's window on the clipboard.
- `cloud.spec.ts`: two people, several devices, the state-income workspace: a second device; a
  read-only share used as input to the reader's own transform; two writers and a conflict; access
  lowered and leaving; signed out.

In CI they run in the `build` job, after the cloud integration tests and against the same stack, so
they're required to merge (they ran as a separate non-blocking job until they had been green 14 times
in a row).

Run locally (needs Docker):

```sh
eval "$(scripts/test-stack.sh)"
VITE_SUPABASE_URL=$SUPABASE_TEST_URL VITE_SUPABASE_KEY=$SUPABASE_TEST_KEY npm run build:e2e
npm run test:e2e            # serves dist-e2e on :4173 and runs the tests
```

**Finding things:** stable test keys (`data-testid`), never layout. Cards are `<kind>-card` with
`data-name` = their name (`dataset-card`, `transform-card`, `viz-card`), menu items `menu.<action>`,
graph nodes `node.<kind>` with `data-name`, plus keys on the add panel (`add.source.<kind>`,
`add.csv-input`), the sync panel (`batch.item`, `batch.option.<push|pull|skip>`, `batch.go`,
`batch.done`), the share panel (`share.email`, `share.level`, `share.submit`, `share.member`), the
transform editor (`transform.sql.<key>`, `transform.output-name.<key>`, `transform.writes-to.<key>`,
`transform.run`) and the workspace (`workspace.save`, `workspace.file-input`). Shared steps are in
`helpers.ts`. The List view is steadier than the graph for reaching items (nodes off the graph's view
can't be tapped until it's panned).

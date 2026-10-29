# Test fixtures

Workspace files the tests open. The CSVs they use are the default map's, in `defaults/socioeconomic/`.

- `socioeconomic.powergis.json`: the default map's pipeline, as the user built it with the six ACS
  county tables as uploads (the UI test replaces them with the CSVs).
- `state-income.powergis.json`: a small, no-spatial pipeline (county income → state averages →
  state map) for the two-person cloud scenarios.
- `counties-only.powergis.json`: just the built-in US counties, so a test's graph stays small.

The EIA utilities map (the default until 2026-10-29) is a default folder now:
`defaults/eia-utilities/workspace.powergis.json`, which the server's unit tests open.

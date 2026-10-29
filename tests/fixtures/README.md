# Test fixtures

Workspace files the tests open. The CSVs they use are the default map's, in `defaults/socioeconomic/`.

- `socioeconomic.powergis.json`: the default map's pipeline, as the user built it with the six ACS
  county tables as uploads (the UI test replaces them with the CSVs).
- `state-income.powergis.json`: a small, no-spatial pipeline (county income → state averages →
  state map) for the two-person cloud scenarios.
- `counties-only.powergis.json`: just the built-in US counties, so a test's graph stays small.

- `utilities-join.powergis.json`: the utilities-by-county map (the default until 2026-10-29; its data
  is gone), which the server's unit tests run over tiny made-up tables: seeding, joins, grouping, exports.

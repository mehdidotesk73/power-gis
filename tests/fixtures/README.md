# Test fixtures

Data and workspace files the end-to-end and integration tests stage. Kept out of
`public/` so they never ship with the app.

Drop in:

- **Data files**: `.csv` / `.geojson`, small (a few hundred rows at most). Name each
  file after the dataset it becomes (e.g. `county_prices.csv` → "county_prices").
- **Workspace**: the `.powergis.json` from Workspace → Download (or Copy, pasted
  into a file). It carries the setup (transforms with SQL, visualizations with
  their settings) and each dataset's name, never rows; the tests match its
  datasets to the files here by name.
- **Expectations** (optional): `expected.md` with what you'd check by hand
  ("the transform gives 87 rows", "Autauga's panel shows 3 utilities").

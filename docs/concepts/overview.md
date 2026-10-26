# About PowerGIS

PowerGIS shows power-sector data on a map of the United States.

## What is this app?

A map of every electric utility operating in the US and the counties each one serves, from the federal EIA Form 861 survey (report year 2025). Each county is colored by what's there — how many utilities serve it, or what kind of ownership is most common — and you can tap any county to see the utilities serving it.

The default map is built the same way you'd build your own, from three tables: **EIA-861 utilities** (one row per utility: name, ownership type, customers, sales and revenue), **US counties** (names, codes and shapes), and **EIA-861 utility ↔ county links** (which utility serves which county). One transform joins them (**Transforms → Utilities by county**); the first visit takes a few seconds while it runs. Other views are transforms over the same tables — a utility's service territory, or utilities per state with `GROUP BY`.

## How do I use it?

- **Find** — pick a visualization, then type: it searches the features' names and every text value in the rows behind them (all data, or one column you pick), and small typos are fine. Picking a match outlines every feature that has it and zooms to them — e.g. on the utilities map, a utility's name shows its whole service territory. ✕ clears it.
- **Tap a county** — a panel opens with each visualization's value there and the rows behind it: on the default map, one row per utility serving the county (name, ownership type, state-wide customers). To outline everywhere a utility operates, use **Find**.
- **Hover** (on a computer) — a small card shows the county and each visualization's value.
- **Datasets** — tables of data. **＋ Add dataset** takes a built-in table, a CSV from your device, a GeoJSON / Esri JSON file, or an ArcGIS link, and stores it as a table in the database (on this device for now). **Saved** lists tables already in the database, to add back or delete. ✕ takes a dataset out of the workspace; the table stays in the database.
- **Visualizations** — what's drawn. Tap **＋ Add visualization**, pick a dataset, choose what to **draw on** — a geometry column (points, lines or regions), and optionally a column that names each feature — and pick the column to show. It tells you how many rows matched.
- **Geometry** — maps draw real shapes from geometry columns. GeoJSON, Esri and ArcGIS data bring theirs, and CSV cells written as WKT (`POINT (-90 35)`) or GeoJSON count too. A CSV with only latitude and longitude columns needs a transform to turn them into points (see **Transforms**). Visualizations from different datasets show together. The default map has four: state borders, a co-op hatch, most common ownership, and number of utilities. Tick any combination — they stack.
- **County or state codes** — a table with FIPS codes or state abbreviations has no shapes of its own. Add the built-in **US counties** or **US states** dataset and join it in a transform, e.g. `SELECT c.geometry, c.name, d.* FROM mydata d JOIN counties c ON c.fips = d.county_fips` — then draw the result's `geometry`.
- **Rename, describe and reorder datasets** — tap ✎ on a dataset to rename it or add a description; drag its ≡ handle to reorder the list.
- **Order and delete** — drag the ≡ handle to reorder: the top of the list draws on top. Swipe a visualization left to reveal **Delete**.
- **Edit a visualization** — choose its column, how rows on the same county are combined (count, sum, average, most common…), and its colors, colormap, transparency and fill pattern.
- **Categories** — coloring by category gives every value its own color. **Palette** picks how: 12, 24 or 60 fixed colors (they repeat if there are more values — the editor tells you), **Many** for any number (shades of 12 colors), or **Auto**, which picks the smallest that fits. If another visualization is on underneath, its colors show through — untick it, or raise the opacity.
- **Vectors (arrows)** — a column holding vectors (direction and size, like a flow) is drawn as arrows automatically. Vectors in separate east / north columns can be combined with a transform: `vector(east, north)`.
- **Transforms** — SQL that makes a new dataset from your datasets. Tap **＋ New transform**, pick the input datasets (search by name — small typos are fine — or paste a dataset id) — each is a table in the SQL by the name after **as** (tap **Insert** to put that name into the SQL where your cursor is; renaming it renames it in the SQL too) — and write one `SELECT`. **Preview** shows the first rows; **Run** stores the result as a dataset and adds it to the workspace (running again updates that same dataset). Examples: `SELECT name, point(lat, lon) AS location, mw FROM plants` turns coordinates into points; joins (`JOIN … USING (fips)`), filters and sums (`GROUP BY`) work too. Save keeps your transforms with the workspace.
- **Preview a dataset** — tap ▤ on a dataset to see its first 20 rows. Tap ⧉ to copy its id (✎ shows it too).
- **Profile** — tap ✎ on a dataset to see, for each column, its type, how full it is, how many distinct values it has, and its range.
- **Demo vector field** — under ＋ Add dataset → Built-in, a made-up wind field to show how arrows look. It is not real data.
- **Export** — download any dataset as GeoJSON, Esri JSON or CSV for ArcGIS. Vectors become two number columns (east and north), which ArcGIS can draw as arrows.

## Common Questions

**Q: What does "Utilities serving county" count?**

A: The number of utilities that report delivering electricity to customers in that county on EIA Form 861. A county commonly has several — say an investor-owned utility in town and an electric cooperative in the countryside.

**Q: Why are customer numbers not per county?**

A: EIA reports customers, sales and revenue per utility per state, never per county. The utilities table holds each utility's total across all its states, so a county's rows show each utility's whole customer count.

**Q: Why is my change not showing?**

A: This is a progressive web app (PWA), which means it caches content locally to work offline. If you deployed a new version but see an old one, try tapping "Reload latest" in the footer or opening the app in a private/incognito tab.

**Q: Can I use this offline?**

A: Mostly. Once you've opened the app, the app itself is cached. The background map tiles come from the internet, so without a connection you'll see the counties without the street map behind them.

**Q: How do I report a bug?**

A: Take a screenshot and share it with the developer. Tap **View logs** in the footer, then **Copy log**, and include that too — it helps debug issues.

**Q: What data is stored on my device?**

A: Only the app's cached files. Files you import stay in your browser and are not uploaded anywhere.
- **Saving** — the bar at the top shows your workspace's name (tap to rename) and whether it has **Unsaved changes**. Tap **Save** to keep them, or **Discard** to go back to the last save. Unsaved changes survive a reload on this device. Added datasets are stored right away; Save keeps which datasets the workspace uses, its visualizations and their order. Today the database is in this browser, so nothing leaves the device; private browsing may not keep anything.
- **Workspace file** — **⋯ → Download workspace file** saves a small `.powergis.json` of the workspace's setup (which datasets, the visualizations and their styles) — not the data itself. **Load workspace file** opens one into this workspace; datasets that aren't in the database are left out, and it tells you. Save to keep what you loaded.
- **Reset** — **⋯ → Reset to the default map** starts over with the default utilities map (Save to keep it); your datasets stay under ＋ Add dataset → Saved.

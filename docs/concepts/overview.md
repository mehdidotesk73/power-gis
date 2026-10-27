# About PowerGIS

PowerGIS shows power-sector data on a map of the United States.

## What is this app?

A map of every electric utility operating in the US and the counties each one serves, from the federal EIA Form 861 survey (report year 2025). Each county is colored by what's there — how many utilities serve it, or what kind of ownership is most common — and you can tap any county to see the utilities serving it.

The default map is built the same way you'd build your own, from built-in tables: **EIA-861 utilities** (one row per utility: id, name, ownership type), **EIA-861 utility ↔ county links** (which utility serves which county), **US counties** and **US states** (names, codes and shapes). One transform joins counties, links and utilities (**Transforms → Utilities by county**); the first visit takes a few seconds while it runs. Other views are transforms over the same tables — a utility's service territory, or utilities per state (join states onto counties by `state_fips`, then `GROUP BY`).

## How do I use it?

- **Search** — the box at the top reads *Search in [visualization] in [All data / a column]*; pick both, then type: it searches the features' names and every text value in the rows behind them (all data, or one column you pick), and small typos are fine. Picking a match outlines every feature that has it in pink and zooms to them — e.g. on the utilities map, a utility's name shows its whole service territory. ✕ clears it.
- **Tap a county** — a panel opens with each visualization's value there and the rows behind it: on the default map, one row per utility serving the county (name, ownership type, state-wide customers). To outline everywhere a utility operates, use **Search**.
- **Hover** (on a computer) — a small card shows the county and each visualization's value.
- **Datasets** — tables of data. **＋ Dataset** takes a built-in table, a CSV from your device, a GeoJSON / Esri JSON file, or an ArcGIS link, and stores it as a table in the database (on this device for now). **Saved** lists tables already in the database, to add back or delete. ✕ takes a dataset out of the workspace; the table stays in the database.
- **Visualizations** — what's drawn. Tap **＋ Visualization** and pick a dataset, then:
  - **Shapes** — the geometry column to draw (points, lines or regions). Rows with the same shape become one feature.
  - **Name shapes by** — optional: a column whose value titles each shape in the hover card, the tap panel and Search. It doesn't affect colors.
  - **Value to show** — what colors each shape (or, for a vector column, its arrows). Several rows on one shape are combined — count, sum, most common… — which you choose in Edit.

  It tells you how many features and rows matched.
- **Geometry** — maps draw real shapes from geometry columns. GeoJSON, Esri and ArcGIS data bring theirs, and CSV cells written as WKT (`POINT (-90 35)`) or GeoJSON count too. A CSV with only latitude and longitude columns needs a transform to turn them into points (see **Transforms**). Visualizations from different datasets show together. The default map has four: state borders, a co-op hatch, most common ownership, and number of utilities. Tick any combination — they stack.
- **County or state codes** — a table with FIPS codes or state abbreviations has no shapes of its own. Add the built-in **US counties** or **US states** dataset and join it in a transform, e.g. `SELECT c.geometry, c.name, d.* FROM mydata d JOIN counties c ON c.fips = d.county_fips` — then draw the result's `geometry`.
- **Graph** — the app shows the graph unless you switch to **List** (it remembers your choice on this device). It shows the workspace as a flow: datasets → transforms → the datasets they make → visualizations. Tap a node to show it below the graph; tap and hold it there for its options, as in the lists. **＋ Dataset** adds a dataset (built-in, file or ArcGIS link). **＋ Transform**: tap the datasets it should read, then **Next**, and write its SQL. **＋ Visualization**: tap the dataset to draw. Move around the graph by dragging it (on a phone: touch and hold, then drag — a quick swipe still scrolls the page); zoom with Shift + scroll, a trackpad pinch, or two fingers on a phone; **＋ / − / ⤢** in its corner zoom and fit it. Arrows are laid out to cross as little as possible; **↓ / →** switches the graph between flowing down and flowing left to right (remembered on this device). Colors tell the kinds apart: datasets are violet, transforms orange, visualizations green. A transform with an amber **↻** badge (**needs re-run**) has an input that changed since it last ran — **↻ Run all stale** re-runs every such transform, and everything that depends on them, in the right order; a dashed one (**not run yet**) has never made its dataset.
- **More room** — **⤢** next to List | Graph opens the panels in a large window (✕ or Esc puts them back; nothing you had open is lost); there, whatever you open sits beside the graph. When you start something new (＋ Transform, ＋ Visualization, ＋ Dataset), the page scrolls to each step for you — the graph to pick from, then the form. On a computer, drag the line between the panel and the map to make the panel wider or narrower (double-click it to reset).
- **Double-tap to open** — double-tap (double-click on a computer) a card to open it: a dataset opens **Explore**, a transform or visualization opens its editor. On visualization cards, the small **Visible / Hidden** pill shows or hides it.
- **Tap and hold for options** — datasets, visualizations and transforms are cards; tap and hold one (right-click on a computer) for its menu. **Reorder** shows ≡ handles on every card — drag them, then tap **Done**.
- **Dataset options** — **Explore** (a window to look through it with SQL: it starts as `SELECT *` over the dataset, shows 200 rows a page with Prev / Next and the total count, and you can filter, sort, group or join it with any other dataset in the workspace by its table name — tap a name to insert it; nothing is saved), **Edit** (rename, describe, see its profile and id), **Copy id** (to paste into a transform's input), **Reorder**, and **Remove from workspace** (the table stays in the database).
- **Visualization options** — the checkbox shows or hides it; hold for **Edit**, **Zoom to data**, **Reorder** (the top of the list draws on top) and **Delete**.
- **Edit a visualization** — choose its column, how rows on the same county are combined (count, sum, average, most common…), and its colors, colormap, transparency and fill pattern.
- **Categories** — coloring by category gives every value its own color. **Palette** picks how: 12, 24 or 60 fixed colors (they repeat if there are more values — the editor tells you), **Many** for any number (shades of 12 colors), or **Auto**, which picks the smallest that fits. If another visualization is on underneath, its colors show through — untick it, or raise the opacity.
- **Vectors (arrows)** — a column holding vectors (direction and size, like a flow) is drawn as arrows automatically. Vectors in separate east / north columns can be combined with a transform: `vector(east, north)`.
- **Transforms** — SQL that makes a new dataset from your datasets. Tap **＋ Transform**, pick the input datasets (search by name — small typos are fine — or paste a dataset id) — each is a table in the SQL by the name after **as** (renaming it renames it in the SQL too) — and write one `SELECT`. Hold a transform for **Preview** (its first rows), **Run**, **Edit** and **Delete**. In the editor, set the inputs and outputs first (one line each: **⤵** puts an input's table name into the SQL, **⇄** picks another dataset); tap an input to see its rows, or an output's **▤** to see what its SQL makes, in the **Preview** panel at the bottom of the editor (tap its header to fold it away); below, each output has its own SQL and **Preview**, and **Run** writes every output together (nothing is written if any output's SQL fails). Each output writes a new dataset or an existing one no other transform writes. Deleting a transform keeps the datasets it made; to make one updatable again, have another transform's output write it. In the editor, **Preview** shows the first rows; **Run** stores the result as a dataset and adds it to the workspace (running again updates that same dataset). Examples: `SELECT name, point(lat, lon) AS location, mw FROM plants` turns coordinates into points; joins (`JOIN … USING (fips)`), filters and sums (`GROUP BY`) work too. Save keeps your transforms with the workspace.
- **Profile** — a dataset's **Edit** shows, for each column, its type, how full it is, how many distinct values it has, and its range.
- **Demo vector field** — under ＋ Dataset → Built-in, a made-up wind field to show how arrows look. It is not real data.
- **Export** — download any dataset as GeoJSON, Esri JSON or CSV for ArcGIS. Vectors become two number columns (east and north), which ArcGIS can draw as arrows.

## Common Questions

**Q: What does "Utilities serving county" count?**

A: The number of utilities that report delivering electricity to customers in that county on EIA Form 861. A county commonly has several — say an investor-owned utility in town and an electric cooperative in the countryside.

**Q: Why is my change not showing?**

A: This is a progressive web app (PWA), which means it caches content locally to work offline. If you deployed a new version but see an old one, try tapping "Reload latest" in the footer or opening the app in a private/incognito tab.

**Q: Can I use this offline?**

A: Mostly. Once you've opened the app, the app itself is cached. The background map tiles come from the internet, so without a connection you'll see the counties without the street map behind them.

**Q: How do I report a bug?**

A: Take a screenshot and share it with the developer. Tap **View logs** in the footer, then **Copy log**, and include that too — it helps debug issues.

**Q: What data is stored on my device?**

A: Only the app's cached files. Files you import stay in your browser and are not uploaded anywhere.
- **Saving** — the bar at the top shows your workspace's name (tap to rename) and whether it has **Unsaved changes**. Tap **Save** to keep them, or **Discard** to go back to the last save. Unsaved changes survive a reload on this device. Added datasets are stored right away; Save keeps which datasets the workspace uses, its visualizations and their order. Today the database is in this browser, so nothing leaves the device; private browsing may not keep anything.
- **Workspace** — the **Workspace** button at the top (next to Help) turns amber with a **●** when you have unsaved changes. Tap it to rename the workspace, see what it holds, **Save** or **Discard changes**, and download, load or reset it.
- **Workspace file** — **Workspace → Download workspace file** saves a small `.powergis.json` of the workspace's setup (which datasets, the visualizations and their styles) — not the data itself. **Load workspace file** opens one into this workspace; datasets that aren't in the database are left out, and it tells you. Save to keep what you loaded.
- **Reset** — **Workspace → Reset to the default map** starts over with the default utilities map (Save to keep it); your datasets stay under ＋ Dataset → Saved.

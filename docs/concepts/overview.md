# About PowerGIS

PowerGIS shows power-sector data on a map of the United States.

## What is this app?

A map of every electric utility operating in the US and the counties each one serves, from the federal EIA Form 861 survey (report year 2025). Each county is colored by what's there — how many utilities serve it, or what kind of ownership is most common — and you can tap any county to see the utilities serving it.

## How do I use it?

- **Find a utility** — type part of a name and pick it from the suggestions. Its whole service territory gets a dark outline and the map zooms to it.
- **Tap a county** — a panel opens with the number of utilities, the ownership mix, and each utility's name, ownership type and customer count. Tap **Territory** next to a utility to outline everywhere it operates.
- **Hover** (on a computer) — a small card shows the county and its largest utilities.
- **Datasets** — tables of data. **＋ Add dataset** takes a built-in table, a CSV from your device, a GeoJSON / Esri JSON file, or an ArcGIS link, and stores it as a table in the database (on this device for now). **Saved** lists tables already in the database, to add back or delete. ✕ takes a dataset out of the workspace; the table stays in the database.
- **Visualizations** — what's drawn. Tap **＋ Add visualization**, pick a dataset, say where each row is on the map (a county or state code column, latitude and longitude columns, or a column holding the shape itself as GeoJSON or WKT — it tells you how many rows matched), and pick a column. The same table can be drawn different ways: change **Features** in a visualization's editor, e.g. from counties to states. Visualizations from different datasets show together. The utilities dataset starts with three: a co-op hatch, most common ownership, and number of utilities. Tick any combination — they stack.
- **Rename, describe and reorder datasets** — tap ✎ on a dataset to rename it or add a description; drag its ≡ handle to reorder the list.
- **Order and delete** — drag the ≡ handle to reorder: the top of the list draws on top. Swipe a visualization left to reveal **Delete**.
- **Edit a visualization** — choose its column, how rows on the same county are combined (count, sum, average, most common…), and its colors, colormap, transparency and fill pattern.
- **Vectors (arrows)** — a column holding vectors (direction and size, like a flow) is drawn as arrows automatically. If your table has the two parts in separate columns (east and north), tap ✎ on the dataset and use **Combine two columns into a vector**.
- **Demo vector field** — under ＋ Add dataset → Built-in, a made-up wind field to show how arrows look. It is not real data.
- **Export** — download any dataset as GeoJSON, Esri JSON or CSV for ArcGIS. Vectors become two number columns (east and north), which ArcGIS can draw as arrows.

## Common Questions

**Q: What does "Utilities serving county" count?**

A: The number of utilities that report delivering electricity to customers in that county on EIA Form 861. A county commonly has several — say an investor-owned utility in town and an electric cooperative in the countryside.

**Q: Why are customer numbers "state-wide"?**

A: EIA reports customers and sales per utility per state, not per county, so the number shown is the utility's total in that state.

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
- **Reset** — **⋯ → Reset to the default map** starts over with the utilities map (Save to keep it); your datasets stay under ＋ Add dataset → Saved.

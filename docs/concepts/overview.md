# About PowerGIS

PowerGIS shows power-sector data on a map of the United States.

## What is this app?

A map of every electric utility operating in the US and the counties each one serves, from the federal EIA Form 861 survey (report year 2025). Each county is colored by what's there — how many utilities serve it, or what kind of ownership is most common — and you can tap any county to see the utilities serving it.

## How do I use it?

- **Find a utility** — type part of a name and pick it from the suggestions. Its whole service territory gets a dark outline and the map zooms to it.
- **Tap a county** — a panel opens with the number of utilities, the ownership mix, and each utility's name, ownership type and customer count. Tap **Territory** next to a utility to outline everywhere it operates.
- **Hover** (on a computer) — a small card shows the county and its largest utilities.
- **Datasets** — the data you've brought in. **Import dataset** takes the built-in files, a CSV from your device, a GeoJSON / Esri JSON file, or an ArcGIS link. Then say where each row is on the map: a county or state code column, latitude and longitude columns, or a column holding the shape itself (GeoJSON or WKT). The panel tells you how many rows matched before you import.
- **Visualizations** — what's drawn. Each one shows a column of a dataset; tap **＋ Add visualization**, pick a dataset and a column. Visualizations from different datasets show together. The utilities dataset starts with three: a co-op hatch, most common ownership, and number of utilities. Tick any combination — they stack.
- **Order and delete** — drag the ≡ handle to reorder: the top of the list draws on top. Swipe a visualization left to reveal **Delete**.
- **Edit a visualization** — choose its column, how rows on the same county are combined (count, sum, average, most common…), and its colors, colormap, transparency and fill pattern.
- **Vectors (arrows)** — a column holding vectors (direction and size, like a flow) is drawn as arrows automatically. If your table has the two parts in separate columns (east and north), use **Combine two columns into a vector** when importing.
- **Demo vector field** — under Import dataset → Built-in, a made-up wind field to show how arrows look. It is not real data.
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

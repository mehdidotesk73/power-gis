# Agents — tool design and workflow

The plan for AI-driven data finding and preparation in PowerGIS (roadmap step 5). Agreed
2026-10-27; pieces marked **(built)** exist. It replaces the earlier Managed Agents plan in
`docs/TODO.md`.

**(built) First leg: the dataset processor.** One agent works on data that's already in PowerGIS:
it studies datasets, writes and runs transforms, and sets up visualizations. Scouting and
scraping (finding data on the web) come next.

| Piece | File |
|---|---|
| Provider-neutral contract: `ChatProvider` / `ChatSession` (text + tool calls in, turn out) | `src/lib/agent/provider.ts` |
| The loop: send, run tool calls, send results, until a text answer; stop, step limit | `src/lib/agent/loop.ts` |
| The tools: definitions, input validation, the store gate, over an `AgentHost` | `src/lib/agent/tools.ts` |
| Instructions (built-ins listed from `shared/builtins.ts`) | `src/lib/agent/prompt.ts` |
| Claude adapter: Messages API from the browser, streaming, keeps Anthropic-format history | `src/client/agent/claude.ts` |
| Chat panel: API key (this device), messages, tool steps, Stop, token use | `src/components/agent/AgentPanel.vue` |
| The host: the page's own functions (draft, `runTransform`, `deleteForGood`, `describeBinding`) | `MapPage.vue` → `agentHost` |

## What the agent does

A user asks for data ("median household income by county, latest year"). One agent, chatting in
a panel inside PowerGIS:

1. **Clarifies** the request: scale, years, statistic, what the map should show.
2. **Scouts** what's publicly available and reports at a high level (below). No downloading.
3. **Points the user to the base data**: links plus exact steps. **The user uploads it**: loading
   base data stays a human step for now.
4. **Explores** the uploaded datasets with SQL (`SUMMARIZE`, `GROUP BY`, join-coverage checks).
5. **Builds transforms** in the workspace draft, runs them, checks the outputs, and fixes them.
6. **Sets up visualizations** and **summarizes** what it built, plus the sources and their usage
   terms.

The user watches it happen in the graph and the map, and **Saves or Discards** the draft as with
their own edits.

## Principles

- **Tools have no business logic.** Each tool checks its input, applies the store gate, and calls
  an operation the UI already uses. Anything an agent can do, a user can do from the UI, and the
  reverse.
- **The agent reads everything and changes only local data.** See *Stores*.
- **Data never passes through the model in bulk.** The agent works through SQL and small results.
- **Workspace edits are a draft.** No approval cards: the draft is already the approval step.

## Stores

**(built)** Every dataset has a `store` (`DatasetRecord.store`, missing = `local`):

- **local**: on this device (IndexedDB). As many as the device holds.
- **cloud** (`remote` in code): Supabase (the `datasets` table + a rows file in its bucket), with a copy here.

The two stores have the same functions; only the storage behind them differs. The user stores a
dataset in the cloud (`storeInCloud`; it keeps its id, so pointers stay valid) and saves its
changes there; agents never do (`storeInCloud` / `fetchFromCloud` refuse `caller: 'agent'`).

**Agent rule: the store decides, not the source.** Any local dataset (built-in copy, upload,
transform output) may be changed or deleted by the agent. Remote datasets are read-only to it,
and only the user deletes them. At the start of a chat the agent lists which datasets are local
("fair game") and suggests moving anything precious to remote.

## Tools

| Tool | Kind | What it does | Built on |
|---|---|---|---|
| `web_search`, `web_fetch` | read | Find sources and read their pages (scouting leg; not given to the dataset processor yet) | Anthropic server tools (`web_search_20260209`, `web_fetch_20260209`) |
| `get_workspace` | read | **Where the agent starts.** (Re)builds the **workspace files** (discarding unapplied edits) and returns `/overview.md`: every dataset, transform (with state and its SQL files) and visualization, one line each, with ids | The workspace draft + registry records (`lib/agent/workspaceFiles.ts`) |
| `list_datasets` | read | Every dataset the user can use, outside the workspace too, local and remote (same fields + `inWorkspace`). Used only when the workspace lacks what's needed, **after asking** | The app's **dataset finder**, `listDatasets()` (`client/datasets.ts`), the same list the pickers use |
| `visualization_stats(id)` | read | The per-feature values a visualization draws (after aggregation): count, nulls, min, percentiles (p2…p98), max, mean, how many ≤ 0 / < 0, orders of magnitude of the positive values; text: distinct count and most common | `queryVisualization` |
| `ask_user(question, details?)` | read | Shows a card with the question, details (what it found, its plan), **Approve / Reject** and a notes box; waits; returns `{answer, notes}` | The chat panel |
| `query_sql(sql, inputs, limit ≤ 50)` | read | One SELECT over any datasets (any store); rows + total count; nothing stored | `previewTransform` |
| `str_replace_based_edit_tool` | edits files | Anthropic's **text editor** (`text_editor_20250728`, declared by type; we run it): `view`, `create`, `str_replace`, `insert` on the workspace files only. Changes nothing until `apply_workspace` | `runEditor` over the staged files |
| `apply_workspace(dryRun?)` | **gated** | Assembles the files, checks the whole workspace (every problem, with its file), replaces the draft; replies with the changes and the **ids of new items**; rebuilds the files | The workspace ops (`addTransform`, `addVisualization`, …) |
| `run_transform(id)` | **gated** | Runs one transform of the draft; returns row counts or the error | `runTransform` |
| `delete_dataset(id)` | **gated** | Deletes a dataset and its rows | `deleteDataset` + `forgetDataset` |

**(built)** The dataset processor has `get_workspace`, `list_datasets`, `ask_user`, `query_sql`,
the text editor, `apply_workspace`, `run_transform` and `delete_dataset`. Datasets are renamed and described in
`/datasets.json` (each workspace dataset by id: `name`, `description` editable; `store`, `rows`, `origin` read-only;
cloud ones refused), applied like any edit — a draft (`WorkspaceDoc.datasetEdits`) written to the datasets on Save.
(`update_dataset` is gone.) Notes from building them:

- **The workspace comes first.** The user normally adds the datasets they care about to the
  workspace, then asks for something. The agent reports which workspace datasets look relevant
  (by name and description, then queries), confirms its plan with `ask_user` unless the request is
  small and clear, and only looks outside the workspace if the user approves.
- **Nothing in the prompt names a dataset.** Outside the workspace the agent uses `list_datasets`,
  which reads the app's dataset finder (`listDatasets()` in `client/datasets.ts`, also behind
  ＋ Dataset → Saved and the default map's seeding). Today that's the datasets on this device;
  with Supabase it becomes these plus the remote registry's datasets the user may access, and the
  agent sees both without changes. Columns, types and values come from queries (`SUMMARIZE`).
- Visualizations go in and out in a **compact form**: `{id?, name, datasetId, geometry, label?,
  column, aggregation?, visible?, color?: {kind: colormap | categorical | constant, …}, opacity?}`.
  The tool fills the rest from the app's own defaults (`makeVisualization`); a kept id keeps its
  style (`retarget`).
- **The workspace is files the agent edits** (`lib/agent/workspaceFiles.ts`). Resending the whole
  workspace failed with Haiku: a big nested payload with SQL inside JSON came back stringified, and
  the retry that got through dropped a transform and every visualization. Now the agent edits a
  **staged copy** with the text editor it's trained on, one small file per item:

  ```
  /workspace.json              index: name, datasetIds, transform ids, visualization ids (draw order)
  /transforms/<id>.json        name, inputs, outputs (key, name, outputId)
  /transforms/<id>.<key>.sql   that output's SQL, plain (found by name: no reference to get wrong)
  /visualizations/<id>.json    one visualization, compact
  /overview.md                 generated, read-only: one line per item, pending edits included
  ```

  An item exists when its id is listed in `workspace.json`; the file name is the id. A new item is a
  file under a name the agent picks (`by_state`), listed in the index; applying gives it a real id
  (the reply's `added`) and rebuilds the files under the ids. Removing = taking the id out of the
  list (the editor has no delete); files nothing uses are reported and dropped.
- **After an apply, files are rewritten** from the draft: new items move to their ids, and every file
  is in the standard format (the agent's own compact JSON is gone). The reply lists `renamed`
  (old path → new path) and says to view a file before editing it; editing an old path afterwards
  is answered with where the file went (renames are remembered for the chat).
- **The layout is taught in the overview.** A built-in tool's description is Anthropic's own: ours
  for the editor is never sent. So `overview.md` opens with "How these files work" (the rules and a
  labelled placeholder example), and refusals state the rule plus only facts read from the files:
  a SQL file off the pattern (`/transforms/x.sql`) is answered with the transform's real output
  keys and their exact paths, or with what a new transform needs — never a guessed key or name.
- **SQL never sits inside JSON**: it's a `.sql` file, written with `create` or edited with
  `str_replace`, one ordinary layer of tool-call escaping. A transform file holding `sql` is refused.
- **Staging rules.** `get_workspace` rebuilds the files from the draft (discarding unapplied edits,
  and says so). With no pending edits they also rebuild themselves when the draft moves on (a run, a
  delete). With pending edits, `run_transform` and `delete_dataset` refuse ("apply_workspace first"),
  and `apply_workspace` refuses if the user changed the draft since the files were built.
- **Apply** assembles the files (every file-level problem listed with its path: missing files,
  invalid JSON, unknown fields, SQL in JSON), then checks the whole workspace as before; nothing
  applies unless all is valid. Items whose files weren't touched are **kept exactly** (style details
  the compact form doesn't show included). `dryRun` describes the change without applying it.
- **Ids, always.** Every action on something that exists names its id (`run_transform`,
  `visualization_stats`, …; no names). The prompt says never to guess one: take it from the overview
  or from `added`, or call `get_workspace`.
- **Strict tools.** Our own tools are declared `strict: true` (`strictSchema` closes every object), so
  the API guarantees their inputs match the schema; the text editor's schema is Anthropic's.
- **SQL errors read against the agent's own SQL**: a query we wrapped (paging, GeoJSON output) that
  fails with a "LINE 1: …" excerpt is planned again bare (`EXPLAIN`) to get the excerpt at its own
  text, and DuckDB's repeated excerpt is printed once (`server/sql.ts` `ownError`, `cleanError`).
- Query results hide geometry (`<region>`) and cut long text, so rows stay small.
- **Styling follows the data.** After adding a visualization the agent calls `visualization_stats`
  and picks the scale (`color.scale: "log"`, a setting of the visualization, never a computed log
  column), sequential vs diverging colormap (rdBu centered with a symmetric `domain` for values
  around a midpoint), and a clipping `domain` (≈ p2–p98) when outliers wash out the map. The
  legend marks clipped ends (≤ / ≥). A log scale starts at the smallest positive value
  (`colormapDomain`, `lib/style.ts`).
- **Images.** The user can paste a screenshot into the message box or attach one (📎); it's shrunk
  to 1,568 px on the long edge as JPEG (`components/agent/images.ts`) and sent before the text
  (`UserMessage.images`).
- A transform the agent runs adds its new outputs to the workspace **without** a first
  visualization (the user's Run adds one); the agent sets up its own.

**Profiling is a query.** `FROM (SUMMARIZE t)` returns per column: type, min, max, approximate
distinct count, mean, standard deviation, quartiles, null percentage, count. There is no
separate profile tool.

**Queries are cheap after the first.** **(built)** Each dataset is loaded into DuckDB once (bulk,
as Arrow) and kept until it changes or the memory budget drops it; the aliases a query uses are
views onto it, so the agent can name tables anything without reloading them.

### The gate

Gated tools are refused, with a message the agent can act on, when:

- `apply_workspace`: the draft changed since the files were built ("get_workspace, then redo the edits"),
  or a transform in the config writes to a **remote** dataset;
- `run_transform`: any of its outputs is remote (its **inputs** may be remote);
- `delete_dataset`: the dataset is remote, or a transform in the draft still reads it.

**(built)** The check runs **in the server** too: agent requests carry `caller: 'agent'`
(`request(type, payload, 'agent')`), and the server refuses their `runTransform` into a remote
output, `deleteDataset` / `updateDataset` of a remote dataset, and any `storeInCloud` / `fetchFromCloud`. A bug in a tool can't bypass it. The tool wrappers check first,
so the agent gets a clear message.

### What the user does

Uploads base data (the agent's turn ends with instructions; the user's next message resumes it),
Saves the workspace, and moves datasets between stores.

## Workflow (one agent, several roles)

One agent and one conversation, with instructions covering each role. Separate sub-agents can
come later if a role outgrows it.

- **Orchestrator.** Narrows the request through questions; checks with the scout findings what's
  realistic (including **alternative metrics** when the ideal one isn't published); decides the
  base datasets, the transforms and the visualizations; tells the user when data quality is
  below what they asked for and asks how to proceed. At most **5 attempts** at any one step
  before reporting exactly what happened.
- **Scout.** High-level availability, not deep research. Per source:
  - coverage by scale (e.g. 90%+ of states, 60%+ of counties, census tracts);
  - detail per scale (min / mean / max vs. mean only);
  - time range and frequency;
  - record counts and data types;
  - consistency between sources (e.g. monthly for 50% vs. annual for 100%: do they agree, and
    which is more reliable);
  - usage terms.

  Shown in the chat as a **source report**; the user picks.
- **Surveyor.** Organizes data into datasets "like a data surveyor": similar sources and
  dependent things together; different major sources or different things apart; many-source data
  of one kind (e.g. per-state DMV records) combined into one dataset with a `source` column.
- **Transformer.** Writes SQL transforms into the draft, runs them, and checks the outputs
  (`SUMMARIZE`, row counts, join coverage, e.g. how many counties found a match). Tests a step
  first with `query_sql` (CTEs chain steps without storing anything), then writes the real
  transform.
- **Visualizer.** Adds visualizations of the final datasets, ordered sensibly, and explains what
  each one shows.

**Run records.** Each chat keeps a record of the request, the clarifications, the source reports,
the sources and usage terms, the datasets and transforms made, and the token use. Sources and
usage policies live **there**, not as dataset properties.

## Runtime

- **The loop runs in the page**, next to the chat panel. Tools call `request()` (server worker)
  and the workspace operations (draft).
- **Each user brings their own Anthropic API key** (Console key; a Claude subscription can't be
  used this way). It's pasted in the app's settings and stored **only on that device**. The app
  calls the Messages API **directly from the browser**: no relay function, no function timeouts.
  A relay with the owner's key can be added later for users without one; only the "send" step
  changes.
- **Model:** the user picks it in the assistant's settings (⚙; `CLAUDE_MODELS` in
  `client/agent/claude.ts`, remembered per device in `powergis.agentModel`; default
  `claude-haiku-5-5`: fast, cheap, and good at this work in the user's tests). **A chat keeps the
  model it started with** (decided: simple, one model per chat). The API would accept a switch
  mid-chat (same history, new `model`; earlier thinking a model can't read is skipped), but a new
  choice applies to the next chat ("Start a new chat"). **(built)** `@anthropic-ai/sdk` `client.beta.messages.stream`
  with `dangerouslyAllowBrowser`, `fallbacks: "default"` on the models that have it (Opus 5.5,
  Opus 5, Sonnet 5.5; beta `server-side-fallback-2026-07-01`: a declined request is retried on
  Anthropic's recommended fallback model), automatic prompt
  caching (`cache_control`). **No `eager_input_streaming`**: the API then checks every tool input is
  valid JSON (a long Haiku input once ended in stray `}]}` and the step failed); tools still validate.
  Follow the `claude-api` skill's TypeScript docs when changing it; don't guess SDK usage.
- **(built) Stop reasons:** `pause_turn` is resumed (up to 5 times); `refusal` and a tool call cut
  off at `max_tokens` stop the turn without running anything; tool calls left unanswered by Stop
  get "not run" results before the next message.
- **(built) Stop is immediate:** `runAgent` races every model call and tool against the abort signal
  (`untilStopped`), so a hung request or a slow tool never holds the chat; work the engine already
  started (a transform run) may still finish unseen. **New chat** works while busy (stops first).
- **(built) Limits:** 40 model turns per user message, then it stops and says "continue" carries on.

## Next: scouting and scraping

Data isn't always a file to download: prices on product pages, shipping quotes from one place
to each state. The user prefers the agent to **collect and assemble data itself** rather than
point them to sources. Two stages, both ending in the same gated tool, `create_dataset(name, rows)`
(local only, size-capped, typed like an upload): the agent's data goes **straight into the app**,
not through a CSV the user downloads and uploads again (Export already covers "give me the file").

### D1 — fetch and create (the agent writes no code)

- `web_search` / `web_fetch` (Anthropic's server tools) for pages and small tables.
- `fetch_data(url)`: our code downloads a CSV / JSON / Parquet file and parses it. Browsers can't read
  most government sites directly (CORS), so it goes through a **small Netlify function proxy** that
  only reaches an allowlist of hosts (census.gov, eia.gov, the PUDL bucket, …) with a size cap — never
  an open proxy.
- Likely covers most requests. Example: county income needs only the ACS table from the Census API
  (~3,200 rows) joined to the built-in counties on FIPS in a transform — not the census shapefiles.

### D2 — agent-written scripts (messy sources: zips, scraping, reshaping)

The agent writes a Python script; the user approves it (an `ask_user` card listing the hosts it will
reach); it runs; its CSV becomes a dataset through `create_dataset`. The script is saved as a
**source script** record — like a transform with no inputs: in the workspace and the graph,
re-runnable when new data comes out, one writer per dataset. Where it runs:

- **Option A (preferred): Anthropic Managed Agents.** A container on Anthropic's side with Python and
  pandas installed, `pip` allowed, networking `limited` to the allowlisted hosts. The app (the user's
  own key) starts a session, the script writes to `/mnt/session/outputs/`, the app downloads the file
  through the Files API (`files.list({scope_id: session.id})`). Nothing big downloads to the phone; no
  CORS; no server of ours. To check first: whether those endpoints accept browser calls (as Messages
  does; else a small relay function), the cost per run (container time + the runner's tokens), and
  that it's a beta API. Proof of concept: one session that fetches one Census API table and writes a
  CSV.
- **Option B: Pyodide** (Python in WebAssembly) in a worker, loaded on first use like DuckDB. Runs on
  the device (tens of MB to download, pandas included), fetches through the D1 proxy.
- Not an option: the plain code-execution tool (it has no internet access); running agent code on a
  server of our own (needs real sandboxing; not before Supabase).

## Later (not decided)

- PowerGIS as a connector inside the Claude apps: postponed; revisit after Supabase.
- Live agent activity in the graph (which agent made what) and a token-usage view.

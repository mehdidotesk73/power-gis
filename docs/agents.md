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
- **cloud** (`remote` in code): the shared database (Supabase, later), within its storage limit.

The two stores have the same functions; only the storage behind them differs. The user moves a
dataset between stores (`moveDataset`; the dataset keeps its id, so pointers stay valid). Until
Supabase exists, moving to remote answers "Remote storage isn't available yet".

**Agent rule: the store decides, not the source.** Any local dataset (built-in copy, upload,
transform output) may be changed or deleted by the agent. Remote datasets are read-only to it,
and only the user deletes them. At the start of a chat the agent lists which datasets are local
("fair game") and suggests moving anything precious to remote.

## Tools

| Tool | Kind | What it does | Built on |
|---|---|---|---|
| `web_search`, `web_fetch` | read | Find sources and read their pages (scouting leg; not given to the dataset processor yet) | Anthropic server tools (`web_search_20260209`, `web_fetch_20260209`) |
| `get_workspace` | read | **Where the agent starts.** Plain text: a **version** stamp, the workspace's datasets (id, name, description, store, origin, row count; no columns), each transform's state (ready / not run / needs re-run), then the workspace as **JSON text with SQL tokens** (`"sql": ${sql:<transform id>.<output key>}`) followed by the **SQL blocks** as plain SQL | The workspace draft + registry records (`lib/agent/workspaceText.ts`) |
| `list_datasets` | read | Every dataset the user can use, outside the workspace too, local and remote (same fields + `inWorkspace`). Used only when the workspace lacks what's needed, **after asking** | The app's **dataset finder**, `listDatasets()` (`client/datasets.ts`), the same list the pickers use |
| `visualization_stats(id)` | read | The per-feature values a visualization draws (after aggregation): count, nulls, min, percentiles (p2…p98), max, mean, how many ≤ 0 / < 0, orders of magnitude of the positive values; text: distinct count and most common | `queryVisualization` |
| `ask_user(question, details?)` | read | Shows a card with the question, details (what it found, its plan), **Approve / Reject** and a notes box; waits; returns `{answer, notes}` | The chat panel |
| `query_sql(sql, inputs, limit ≤ 50)` | read | One SELECT over any datasets (any store); rows + total count; nothing stored | `previewTransform` |
| `edit_workspace(version, edits, values?, dryRun?)` | **gated** | Exact replacements on that text: `{old, new}` in the JSON, or `{sql, old, new}` inside one SQL block; new SQL goes in `values` as plain text and is named `${name}` in the JSON. Checked whole, all-or-nothing; `dryRun` describes the change without applying it | The workspace ops (`addTransform`, `addVisualization`, …) |
| `run_transform(id)` | **gated** | Runs one transform of the draft; returns row counts or the error | `runTransform` |
| `update_dataset(id, name?, description?)` | **gated** | Renames / describes a dataset (rows untouched); the agent names and describes what it keeps | `updateDataset` |
| `delete_dataset(id)` | **gated** | Deletes a dataset and its rows | `deleteDataset` + `forgetDataset` |

**(built)** The dataset processor has `get_workspace`, `list_datasets`, `ask_user`, `query_sql`,
`edit_workspace`, `run_transform`, `update_dataset` and `delete_dataset`. Notes from building them:

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
- **Edits, not rewrites** (`edit_workspace`, replacing `update_workspace`): resending the whole
  workspace failed with Haiku — a big nested payload of SQL inside JSON came back stringified, and
  the retry that got through dropped a transform and every visualization. Now the agent changes
  the text `get_workspace` shows with exact `old` → `new` replacements (each `old` must occur once;
  zero or several matches are refused with a hint), so a small change is a small call.
- **SQL never travels inside JSON.** In the text each output's SQL is a token, and the SQL itself
  is listed below as plain SQL. New SQL goes in `values` (plain strings) and the JSON names it
  (`"sql": ${q1}`, no quotes); the tool inserts `JSON.stringify(value)`. An existing SQL is edited
  inside its block (`{sql: "<transform id>.<output key>", old, new}`). Tokens are filled in one pass,
  so an inserted value is never read for tokens again; a literal `${` in a name is shown as
  `$\u007b`.
- The edited text is parsed and checked like a whole workspace (every problem listed, nothing
  applied unless all is valid). Items whose text didn't change are **kept exactly** (as `{id}`),
  style details the text doesn't show included; changed ones are rebuilt from the app's defaults
  plus what the text says. The answer lists what changed (`transform changed: "…"`, …);
  `dryRun: true` gives the same list without applying it.
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

- `edit_workspace`: the draft changed since `version` ("re-read the workspace and try again"),
  or a transform in the config writes to a **remote** dataset;
- `run_transform`: any of its outputs is remote (its **inputs** may be remote);
- `delete_dataset`: the dataset is remote, or a transform in the draft still reads it.

**(built)** The check runs **in the server** too: agent requests carry `caller: 'agent'`
(`request(type, payload, 'agent')`), and the server refuses their `runTransform` into a remote
output, `deleteDataset` / `updateDataset` of a remote dataset, and any `moveDataset`. A bug in a tool can't bypass it. The tool wrappers check first,
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

# Agents — tool design and workflow

The plan for AI-driven data finding and preparation in PowerGIS (roadmap step 5). Agreed
2026-10-27; nothing here is built yet except the pieces marked **(built)**. It replaces the
earlier Managed Agents plan in `docs/TODO.md`.

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
- **remote**: the shared database (Supabase, later), within its storage limit.

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
| `web_search`, `web_fetch` | read | Find sources and read their pages | Anthropic server tools (`web_search_20260209`, `web_fetch_20260209`) |
| `get_workspace` | read | The workspace config: datasets (id, name, store, origin), transforms (full spec + ready / not run / needs re-run), visualizations (full settings), plus a **version** stamp | The workspace file format (`lib/workspace/file.ts`) + registry records |
| `query_sql(sql, inputs, limit ≤ 50)` | read | One SELECT over any datasets (any store); rows + total count; nothing stored | `previewTransform` |
| `update_workspace(config, version)` | **gated** | Replaces the draft with a modified config | Loading a workspace file into the draft |
| `run_transform(id)` | **gated** | Runs one transform of the draft; returns row counts or the error | `runTransform` |
| `delete_dataset(id)` | **gated** | Deletes a dataset and its rows | `deleteDataset` + `forgetDataset` |

**Profiling is a query.** `FROM (SUMMARIZE t)` returns per column: type, min, max, approximate
distinct count, mean, standard deviation, quartiles, null percentage, count. There is no
separate profile tool.

**Queries are cheap after the first.** **(built)** Loaded tables stay in DuckDB until their dataset
changes (`createSqlRunner`, keyed by dataset id + `updatedAt`), so repeated queries over the same
table don't reload it.

### The gate

Gated tools are refused, with a message the agent can act on, when:

- `update_workspace`: the draft changed since `version` ("re-read the workspace and try again"),
  or a transform in the config writes to a **remote** dataset;
- `run_transform`: any of its outputs is remote (its **inputs** may be remote);
- `delete_dataset`: the dataset is remote, or a transform in the draft still reads it.

The check runs **in the server** too: agent requests carry `caller: 'agent'`, and the server
refuses remote writes for them. A bug in a tool can't bypass it. The tool wrappers check first,
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
- **Model:** `claude-opus-5-5` for every role, streaming, adaptive thinking. Follow the
  `claude-api` skill's TypeScript docs when writing it; don't guess SDK usage.
- **Server tool pauses:** a long web-search step can end with `pause_turn`; the loop sends it back
  to continue.

## Later (not decided)

- Agent-written download / parse functions (in the app, or on a real backend).
- PowerGIS as a connector inside the Claude apps: postponed; revisit after Supabase.
- Live agent activity in the graph (which agent made what) and a token-usage view.

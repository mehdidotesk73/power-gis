# Experience — Lessons & History

Record what you learn as you build: patterns that work, ideas that didn't pan out, and a version history of major changes.

## What Didn't Work (Gotchas & Dead Ends)

### Managed Agents can't be called from a web page (2026-10-30)

The scout / scraper proof of concept called Anthropic's Managed Agents API straight from the browser,
like the chat does with `/v1/messages`. Every run failed with only "Connection error": the browser's
CORS preflight to `/v1/environments` and `/v1/files` gets a 400, `/v1/agents` and `/v1/sessions` a 405,
none with `Access-Control-Allow-Origin`, so the request is never sent. Only `/v1/messages` allows
browsers. Fix: a small relay (Supabase Edge Function `managed-relay`) that forwards those paths, and
polling a session's events instead of a stream (edge functions have time limits). **Then:** on the hosted
project the key never reached Anthropic ("x-api-key header is required") though the local stack passed
it, so the hosted gateway drops `x-api-key`: the app also sends the key as `x-relay-key`, which the relay
copies, and a keyless request answers with the header names that did arrive. Check a new
endpoint's preflight with `curl -X OPTIONS -H 'Origin: …' -H 'Access-Control-Request-Method: POST'`
before building on it from the page.

### Mobile-First Design Constraints

Touch targets need to be at least 44×44px. Avoid hover-only interactions — users on mobile have no hover. Rethink interactions like "expand on hover" as "toggle on tap" or always-expanded. Test regularly on actual mobile devices, not just the browser's responsive mode.

### Service-Worker Caching & Stale Builds

A PWA caches aggressively to work offline. If a user opens your app, then you deploy a new version, the old bundle may keep serving until they:
- Manually tap "Reload latest" (we surface this in the footer)
- Force-refresh (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows)
- Open in a private/incognito tab
- Wait for the service worker to auto-update (can take hours)

Always surface a visual "update ready" affordance so users know to reload. See `App.vue` for the implementation.

### ECharts Gotchas (if using charts)

On a **category x-axis**, `visualMap` (color ranges) and per-segment `lineStyle` colors do **not** bind as expected. If you need per-point coloring on a category axis, use a series with per-point `itemStyle` instead. Register new chart types explicitly with `echarts.use([LineChart, ...])` — ECharts doesn't auto-register components.

### Pure Logic vs. Components

Logic lives in `src/lib/` as plain functions over already-fetched arrays. They recompute instantly with no API refetch. Keep components thin — they should mostly render. This separation makes logic testable and reusable without rebuild cycles.

### Don't Hand-Write a Static `public/manifest.json`

`vite-plugin-pwa` generates `manifest.webmanifest` and injects its own `<link rel="manifest">`. A second static `public/manifest.json` linked from `index.html` produces two competing manifest links in the built HTML, and the static one wins in some browsers — pointing at icons the build never processed. Define the manifest once, in the `VitePWA({ manifest: ... })` block.

### Database Support Is for Live Apps, Not "Stateful" Apps

Recorded as posed. The examples carry the distinction better than any taxonomy built on top of them would:

> I think the database support is for live apps not stateful apps. Depends on what defines a state. But there can be an app that accesses a database to create some sort of coherencey between different running instances of the app. Another form of state is an app that links to a resource and loads into app states for example an accounting app that sets up connection to a text file on web or a csv local file that it has read and write access to, and allow reading the state, modifying the state and saving the state. The latter is a lower level of statefulness. And another level is like a flappy bird app game that does not keep highscores or anything. The app runs, you click play, you play the game, when you die your score is displayed and button for play again. No external state at all just an endless loop of internal states.
>
> Different forms of state might need different infrastructure.

### Realtime Statefulness — a Variation With No Stored State

A further form, alongside the ones above: **state that is live between running instances and stored nowhere.** Four players in a game, a shared cursor, a live drawing surface. Separate copies must agree — but the agreement is only about *now*, and a value that's 200ms old is worthless rather than merely stale.

That is not what a database is for, and Supabase serves it with a different primitive. `postgres_changes` (what a shared shopping list uses) is a real row write replicated off the WAL and then fanned out — correct when the data must persist, far too heavy when it must not. **Broadcast** is plain pub/sub over the same WebSocket and never touches Postgres.

How the connection actually works, since the obvious guesses are both wrong — instances neither share a socket nor join one that a host opens:

- Every client opens **its own** WebSocket to the Realtime server and subscribes to a **topic name**. The server relays between whoever named the same string. It's rendezvous by string, like a chat room name.
- **Nobody creates or owns a channel.** The first subscriber doesn't set it up; the last to leave doesn't tear it down. If the app needs an authoritative host, that's an election the app runs — the transport has no such concept.
- **One socket per client, multiplexed.** Several `.channel()` calls share it.
- **Nothing is stored, and there is no replay.** A message sent before you subscribed is gone, so a late joiner arrives blind and must be handed a snapshot explicitly.
- **Traffic always goes to the region and back.** Two devices on the same wifi still round-trip to Supabase. That's the latency floor; WebRTC is the only way under it.
- The **channel name is the entire access control** on a public channel — so a random room code, for the same reason list ids are random.
- **Presence** rides the same channel and gives the roster (join/leave) without building it.

### Netlify Doesn't Rebuild When You Change an Environment Variable

The database worked on branch previews, then didn't, and a fresh rebuild fixed it with no code change and no config change. The variables had been set on all scopes from the start, so the configuration screen gave no hint anything was wrong.

The root cause was never pinned down, and it's recorded here as an open case rather than a solved one. The leading candidate is build-time staleness: **Vite inlines `VITE_*` into the bundle at build time**, and **Netlify does not trigger a deploy when an environment variable is edited** — so a build can predate its own configuration and serve `undefined` while the dashboard shows everything set correctly. That fits "a rebuild fixed it" without any code change. The service worker serving a stale bundle fits too, and the two aren't exclusive.

The useful part isn't the diagnosis. It's that **a rebuild is cheap and rules out a whole class of cause**, so it's worth trying early rather than after reading the code. And that when a value is compiled in rather than read at runtime, every configuration screen can look correct while the served artifact disagrees — the tell is the deploy's timestamp, not the value.

Worth noting the graceful `supabase = url && key ? createClient(...) : null` guard makes this harder to see. It's the right pattern — it keeps the required `build` check green in CI, where no variables are set — but it converts the failure into a feature that silently does nothing. Pairing it with `logDebug('Supabase not configured — sharing disabled', 'warn')` is what would have turned "sharing is broken" into a log line naming the cause, which is also how we'd know which candidate above was right.

### `using (true)` Is Not "Anyone With the Link"

A Supabase walkthrough that otherwise went well described its RLS policies as making rows "readable/writable by anyone with a list's id — that's what link-only sharing means at the database level," and compared it to a Google Docs anyone-with-the-link share. The SQL was `create policy ... for all using (true)`, and that claim is wrong in a way worth keeping.

`using (true)` grants the anon role **the entire table**. The client can `select *` and enumerate every row; it never has to know an id. Both values needed to do it — project URL and publishable key — are readable in the shipped JavaScript bundle, because that is what those values are for. The unguessable `gen_random_uuid()` stops someone *guessing* a link; it does nothing once they can just list the table. Google Docs actually enforces link-sharing server-side, so the analogy claims a property the database does not have.

It's usually an acceptable trade-off — a shopping list between two people does not need more — and the fix is not always harder SQL. The fix is describing it accurately: *"keeps it away from anyone who wasn't sent the link, and off search engines; not private in a bank-account sense."* Real link-only enforcement needs table access revoked and `security definer` functions taking the id as an argument, which is a bigger piece of work and should be scoped as one.

Same family as the disabled ruleset and the blank Netlify project name: **a setup that looks configured and enforces less than it appears to.** The difference here is that the gap lands in what Claude *tells* the user, not in what they clicked — which makes it harder to catch, since nothing ever fails.

### A Multi-Select Gate Without a Recommendation Is a Quiz the User Can't Pass

The pre-merge doc gate listed its four surfaces neutrally and asked which to update. But the user is non-technical and did not read the diff — they have no basis for judging whether a branch touched "architecture" or made a help page wrong. Asking anyway pushes a decision onto the person least equipped to make it, and the rational responses are to tick everything or tick nothing, neither of which is a judgement.

Claude is the only participant who knows what changed, so the recommendation has to be worked out *before* the question is posed and carried in the options themselves: recommended ones first with **(Recommended)**, and each description naming the specific thing in *this* branch that triggers it. "The Browse page got a category filter, so its help page now describes the old behaviour" is a fact they can accept or reject. "If UI changed, update the help doc" is homework.

**The failure mode to avoid is recommending all four defensively.** If everything is always recommended the recommendation carries no information, and it's the neutral list again with more words. Actively clearing a surface — "nothing here changed the architecture" — is worth as much as flagging one.

Generalizes past this gate: whenever a question is posed to someone who can't see what you can see, the options have to carry your reading of the situation, not just the choices. The user still decides; they just shouldn't have to reconstruct the evidence first.

### A Log Panel Nobody Writes To Is Just an Empty Box

The scaffold shipped the *display* half of on-device debugging — a reactive buffer, a log panel, a **Copy log** button, an error-count dot — and none of the *capture* half. `main.ts` was three lines with no `errorHandler`, no `window.error` listener, no `unhandledrejection` handler. The only entries that ever appeared were ones someone had hand-written a `logDebug()` call for, which means the panel could only report failures that had already been anticipated. The user opens it after a button misbehaves and reads "No log entries yet."

**The case that matters is not the white screen — it's the button that does nothing.** And that one has a specific trap: **Vue catches throws inside event handlers itself.** A handler that throws never reaches `window.onerror`; Vue routes it to `app.config.errorHandler`, and if that's unset the error is logged to a console the phone user cannot open. So the single most common user-visible failure was the one path a naive `window.onerror` would have missed.

Four sources are needed, and each catches something the others don't: `app.config.errorHandler` (handlers, hooks, watchers), patched `console.error`/`warn` (library output, Vue's own warnings), `window.error` **in the capture phase** (plain script errors, plus failed image/script/stylesheet loads, which don't bubble), and `unhandledrejection` (the un-awaited `fetch` in an async handler). Patching the console needs care: bind the native methods *before* patching and have `logDebug` use those, or writing to the panel re-enters the patch and records itself.

Two things that only matter because the user is non-technical: **repeated identical errors collapse to `×N`**, since a handler that throws on every tap would otherwise flush the one useful message out of a 100-entry buffer with copies of itself; and **`copyLog` has an `execCommand` fallback**, because `navigator.clipboard` needs a secure context and this is the only channel from the phone back to Claude — a silent failure there loses the entire bug report.

Verified with Playwright against the built app rather than argued from the code: a throwing handler, a `console.error`, a rejected promise, a 404 image and five repeats all land in the panel, the footer badge turns red with the count, and **Copy log** sits inside the opened window. Worth doing because all four handlers were unverifiable by reading, and the sandbox can drive a real browser.

### Mobile Autocapitalization Silently Breaks Exact-Match Identifiers

Told to add a required status check named `build`, a user on iOS typed it into GitHub's search box and got `Build` — the keyboard capitalized the first letter, as mobile keyboards do by default in text fields. GitHub duly offered **+ Add Build · Any source**.

Adding that would have been a full lockout. Check names match literally, so a rule requiring `Build` waits forever on a check reporting as `build`; combined with an empty bypass list, every PR the user ever opened would be unmergeable — on a ruleset that reads as correctly configured, Active, with all the right boxes ticked. Exactly the failure **Required approvals: 0** was chosen to prevent, arriving through a completely different door.

Two things follow:

**This audience types on phones, so any instruction to enter an identifier needs its casing stated.** "Type `build`" is insufficient; "type `build`, all lowercase — your phone will try to capitalize it" is the instruction. Applies to anything matched literally: check names, branch patterns, project names.

**Better still, don't have them type it at all.** Both of the above are mitigations for an input step that turned out to be avoidable — see the entry below on triggering CI early, which makes `build` a listed option the user selects instead of an identifier they transcribe. Casing guidance and readbacks remain as the fallback, but the durable fix was removing the keystroke, not perfecting the instruction around it.

**And where a readback is still needed, it matters more than the instruction.** The user can follow "type `build`" perfectly and still end up with `Build`, because the corruption happens after they act, not during. That's what makes it different from a misread instruction — no amount of clarity in the telling prevents it. The only reliable catch is asking what's actually in the field before they commit, which is the same reason the confirmation gates restate the expected result rather than just asking "done?".

### Don't Schedule a Check-In for a Two-Minute Deploy

Waiting on a deploy (this happened with the GitHub Pages build the template used to have) by scheduling a background check-in produced the worst available shape: the turn ended on "I'll check back in a couple of minutes", the conversation stalled, and the user — sitting right there — got bored and checked manually. The deploy had already succeeded. The automation added latency and dead air to something that takes ninety seconds.

Poll it in-turn instead, or hand the check to the user as an ordinary confirmation gate ("takes about two minutes, tell me when the run goes green"). Both beat a promise that parks the conversation. Background scheduling earns its place on long or unattended waits; during an interactive setup the user is a faster and more reliable signal than a timer. Still applies to Netlify's own builds now that they're the only deploy pipeline.

### Netlify Site Names Are a Global Namespace

Every Netlify site lives under `*.netlify.app`, one pool shared across the platform, so plain names like `grocery-assistant` are long gone. Propose a distinguished name (username, initials, an extra word), keep alternates in reserve, and warn the user it may be taken — then a rejection is a ten-second retry instead of a failure.

The subtler failure is **doc rot**: the name is chosen at intake and committed into the scaffold (README URLs, the deploy-preview pattern in the project's `CLAUDE.md`), but isn't tested against reality until Netlify setup several steps later. If it changes there and the docs aren't updated, the project's documentation points at a stranger's live site — a wrong link, not a broken one, so nothing surfaces it. Any value committed before external validation needs a write-back once the real value is known.

### A Guided Step Needs a Link and a Value for Every Required Field

The branch-protection step told the user "Go to your repo on GitHub → Settings → Rules → Rulesets" and then listed seven instructions that never supplied a **Ruleset Name** — a field GitHub requires and leaves blank. Two failures in one message, and both had already been fixed once, elsewhere:

**A navigation path is not a link.** Four hops through a settings menu someone has never opened, on a phone, is work the message could have done for them. Deep links exist: `https://github.com/<owner>/<repo>/settings/rules`. Give the URL and keep the click-path as a one-line fallback for when it doesn't resolve.

**Every field the form requires needs a value in the message.** This is the same bug as Netlify's blank Project name, one page later. The instruction covered what to tick and what to leave alone, and simply had nothing to say about the field at the top — so the user stops, mid-step, holding a decision the instructions implied wouldn't come up. If the value genuinely doesn't matter, that's still a reason to supply one (`protect main`) rather than to omit it; "any name works" is a thing to know, not a thing to have to invent.

The general form: **walk the actual form, field by field, and check the message accounts for each one** — including the ones that don't matter. Steps get written from the interesting parts (which rules, which checks) and the boring required field at the top is what gets dropped.

**Follow-up: the link then shipped in backticks and rendered as dead text.** Code formatting suppresses auto-linking, so `https://github.com/.../settings/rules` arrived as a string the user couldn't tap — leaving them to select and copy a long URL on a phone, which is worse than the four-hop click-path the link was supposed to replace. The habit comes from treating every literal the same way; URLs are the exception. Backticks are for values the user **types** (names, branches, check names, where exact characters matter and a link would be wrong). URLs are for **tapping** and go bare in running text. Worth noticing that `ship-feature`'s three hand-off links were already bare and had been working the whole time — the inconsistency is what hid the bug.

### `npm ci` Needs a Committed Lockfile

The CI workflow runs `npm ci`, which fails outright ("can only install packages when your package.json and package-lock.json are in sync") if `package-lock.json` isn't committed. It's tempting to gitignore lockfiles; don't. Commit it whenever dependencies change.

### `declaration: true` in an App's tsconfig

Emitting declarations for an *app* makes `vue-tsc` demand exported names for every type used in a component's public surface — a `defineProps` interface that isn't exported fails with `TS4082: Default export of the module has or is using private name 'Props'`. Declarations matter for libraries, not apps. Dropping `declaration`/`declarationMap` is the fix, not exporting every internal interface.

### Ambient Types for Build-Time Constants

`__BUILD_ID__` and `__BUILD_TIME__` are injected by Vite's `define`, and `virtual:pwa-register` only exists at build time. TypeScript knows about none of them without an `src/env.d.ts` declaring the constants and referencing `vite/client` and `vite-plugin-pwa/client`. Without it the build fails with `TS2304: Cannot find name '__BUILD_ID__'`.

## Patterns Worth Reusing

### Two-Party Link Apps: the URL Fragment as Credential, and the Join Race

Two people share one thing via a link, with no accounts — a chat, a 1:1 handoff, an approval between
two roles. Two pieces here are worth reusing **whether or not anything is encrypted**, which is why
they sit outside the encryption pattern below.

**The URL fragment is a credential store you already have.** Everything after `#` is never sent in
an HTTP request — not to the host, not to the database, not in a `Referer` header, not into server
access logs. So `#/chat/<id>/<role>/<packedKey>` hands someone a real secret with no login, no
password, and nothing server-side to store. Pack it by exporting the key as JWK →
`JSON.stringify` → base64 → URL-safe alphabet (`+/` → `-_`, strip `=`).

That's a complete answer to *"how do we give someone a real credential without building a login
system"*, and it's the most transferable idea here. What it is **not** is secret from everything:

- **Any JavaScript on the page can read `location.hash`.** Add an analytics snippet, a chat widget,
  any third-party tag, and it can exfiltrate every user's private key. This is the failure that
  matters most, because it arrives later, innocently, in an unrelated PR.
- It lands in **browser history**, which may sync across a user's devices.
- It's **on screen** — in screenshots, screen shares, and over a shoulder.
- **The link is the account.** Whoever holds it *is* that party, and losing it loses everything with
  no reset. Say that to the user in those words.

**Guard the join with a conditional update, not a plain one.** When the second person to open an
invite claims a role, do it as:

```sql
update sessions set joiner_public_key = $1
where id = $2 and joiner_public_key is null
```

Then **check the affected row count** rather than trusting that the update "succeeded" — zero rows
means somebody else got there first, and the app should say so instead of silently continuing as a
participant it isn't. Without this, a third visitor to a shared link quietly overwrites the real
joiner and takes over the session.

Be honest about its reach: with a permissive `using (true)` policy this stops the *accidental*
second joiner, which is the realistic case. It does not stop someone determined, who can issue the
same update themselves. It's cheap, it fixes the failure that actually happens, and it isn't
authentication.

### End-to-End Encryption Over a Database You Don't Trust

For a messaging app, or anything where the rows live in a database but their contents shouldn't be readable by whoever can read the database. The server stores ciphertext and public keys; it never sees plaintext or any private key.

**Key agreement is Diffie–Hellman (ECDH).** Each side has a keypair and publishes only the public half. The trick is that combining *your private key with their public key* produces the same value as combining *their private key with your public key* — so both ends arrive at one shared secret that never crosses the wire. On elliptic curves the combining step is scalar multiplication, not hashing. Hashing comes one step later: run the raw shared secret through HKDF to get the actual symmetric key.

Then AES-GCM with that key, **a fresh random IV per message**. Reusing an IV under the same key breaks GCM badly — it's the one implementation mistake that turns this from real encryption into none.

The browser does all of it natively; no library:

```ts
// once per identity — publish publicKey, keep privateKey off the server
const kp = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])

// per conversation — both sides compute the identical key
const key = await crypto.subtle.deriveKey(
  { name: 'ECDH', public: theirPublicKey }, myPrivateKey,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

// per message
const iv = crypto.getRandomValues(new Uint8Array(12))
const ciphertext = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv }, key, new TextEncoder().encode(text))
```

**Storage shape: pairwise, not user-keyed.** Built for real, this wants no `profiles`/`users` table
at all — there is no identity beyond "the two people in this row", so the role is an enum and the
public keys are slots on the shared row:

```sql
create table sessions (
  id uuid primary key default gen_random_uuid(),
  starter_public_key text not null,
  joiner_public_key  text,            -- null until the second party arrives
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  sender text not null check (sender in ('starter', 'joiner')),
  ciphertext text not null,
  iv text not null,
  created_at timestamptz not null default now()
);
```

The IV is stored beside the ciphertext and is not secret. `sender` as a role check rather than a
foreign key is the part that generalizes to any small fixed-N arrangement.

**Two realtime subscriptions, not one:** an UPDATE on the session row, so "waiting for the other
person" becomes a live transition rather than a poll, and a session-filtered INSERT on messages.
Letting your own sends round-trip through that same INSERT subscription instead of rendering
optimistically avoids a duplicate-render race, and the added latency isn't noticeable.

**Key custody, when the user holds it.** Simplest workable version: the user enters a passphrase at the start of a session, and it never leaves memory. Two ways to get from a passphrase to a keypair — wrapping is the one to prefer:

- **Wrap** (recommended): generate a random keypair once, encrypt the private key under a PBKDF2/Argon2-derived AES key, store that wrapped blob in the DB. The passphrase unwraps it. Safe to store because it's useless without the passphrase, and it works on any device.
- **Derive deterministically**: turn the passphrase directly into the private scalar. No blob to store, but importing a raw scalar as a P-256 key via JWK is fiddly and easy to get subtly wrong.

Either way the passphrase is the whole system: **lose it and every past message is permanently unreadable.** There is no reset. Say that to the user in those words before they pick one.

**Be precise about what this protects, and what it doesn't.** Same discipline as not calling `using (true)` "link-only":

- **The server can still MITM you** if it's the one telling you the recipient's public key — it can substitute its own and read everything. Closing that needs an out-of-band fingerprint check, which is what Signal's "safety numbers" are.
- **No forward secrecy** with static keypairs: one compromised private key decrypts every message ever sent. Rotating per message (Double Ratchet) is a much larger build.
- **Metadata stays plaintext.** Who talked to whom, when, and how often are ordinary readable columns. Encryption hides content, not the social graph.
- **Group chat breaks the pairwise model.** Encrypt the message once under a random key, then wrap that key separately for each recipient.

One good side effect, worth stating the right way round: `using (true)` still means anyone with the URL and publishable key can list the whole table — **the encryption is what makes that normally-too-permissive default acceptable here**, since what they enumerate is ciphertext. It is not that the policy became safe.

### Chained-Scenario E2E Tests for Step-Triggered State Machines

For an app whose state changes only in response to an explicit user action — no scheduler, no NPC loop, no second user acting concurrently. Within that, some behaviour only appears across a *sequence* of dependent steps: create a thing, act on it as a second actor, respond as the first, then check both sides. Unit tests can't reach it — it needs a real trigger, a real round trip, and real settled state before the next step is even valid. A single "does the feature work" E2E test misses it too, because the bug lives in the interaction between steps. In practice this caught a UI bug that only appeared on the *second* modal opened in a sequence, which no single-step test or manual happy path had surfaced.

**Test against the live backend, when the access model makes that safe.** If RLS is `using (true)` everywhere, a test-created row is no more exposed than any row already there, and testing the real thing catches what a mock cannot: actual query shapes, actual constraint violations, actual realtime propagation delay. Simulate separate devices with separate browser contexts (`browser.newContext()`) — anything kept in `localStorage` is shared inside one context and isolated across them, which is the guarantee two real phones would give you.

**Clean up by manifest, not by tagging.** When primary keys are generated UUIDs and lookup columns are hashed rather than plain, there is nothing free to prefix with a "test data" marker without changing the schema. Instead have the harness track what it creates, using the identifier it already holds, and at teardown re-derive the same lookup the app uses and delete directly:

```ts
export interface TestManifest {
  track(identity: GeneratedIdentity): void
}

async function cleanupIdentity(identity: GeneratedIdentity): Promise<void> {
  const lookupTag = deriveLookupTag(identity) // the app's own derivation — import it, don't copy it
  await supabase.from('main_table').delete().eq('owner_tag', lookupTag)
  await supabase.from('accounts_table').delete().eq('public_key', identity.publicKey)
}
```

**Chain steps on positive, waitable signals — never a fixed sleep.** Each step fires only once there's proof the previous one propagated: a value changing, an element appearing, a count moving. When the thing you care about has no signal of its own — "the fetch that would have populated an empty list finished" produces no marker when the list stays empty — wait on an *adjacent* signal known to complete alongside it, then assert the silent thing.

**Poll and read as one operation when a value passes through an intermediate state.** If a field shows "Generating…" on its way to a real value, checking "did it change?" and then reading it separately can land the read inside the placeholder window — the placeholder satisfies "changed" without being the answer. Re-read inside the assertion on every attempt so only a settled value passes:

```ts
let value = ''
await expect(async () => {
  value = await input.inputValue()
  expect(value).not.toBe(previousValue)
  expect(value).not.toBe('Generating…')
}).toPass({ timeout: NETWORK_TIMEOUT })
```

**Read the app's own debug log from the test.** The on-screen error capture built for phones with no console is a far better CI diagnostic than an assertion message: it holds the real thrown exception rather than "the click had no visible effect". Dumping it into the thrown error turns a silent timeout into a stack trace without a repro machine.

**What it does not do:**

- **It does not handle live background processes.** NPCs ticking, a scheduled job, another real user acting at the same time — there may be no stable settled state to wait for. That needs seeded randomness, a controllable clock, or a fake behind the nondeterministic part.
- **Live-database testing is only safe under the access-control condition above.** Against a backend with real per-user isolation, a cleanup bug or a mid-suite crash leaves residue exposed to real users.
- **It does not replace unit tests of pure logic.** It's for what unit tests structurally cannot reach, and it's far slower per assertion.
- **Manifest cleanup has no built-in proof it deleted anything.**

Two additions from reviewing it here, beyond what the originating project reported:

- **Exposure and pollution are different risks.** "No more exposed than any other row" is true, and separate from the fact that test rows are *live data*: if the app lists rows rather than fetching by id, test sessions appear in real users' UI. Check whether any screen enumerates before pointing a suite at production.
- **Fix cleanup drift by importing, not by verifying.** The stated gap — the harness's copy of the app's derivation silently going out of sync — can't be closed by re-querying after delete, since the check would use the same stale derivation and report success. **Import the derivation from the app's own source.** If it genuinely can't be imported, pin the two together with a unit test asserting both produce the same output for a fixed input; that fails loudly on the next change instead of orphaning rows in silence.

## Version History

(Record major releases here as you merge features. Example format below.)

### The assistant sends the scout and the scraper — 2026-10-30

- **Added:** `send_scout` / `send_scraper`: the assistant says how well the workspace fits, asks where to
  look, and sends a run on approval (brief, cap); the run shows as a step in the chat, can be stopped, and is
  picked up again after a reload; the scraper's CSVs become datasets.
- **Added:** ask_user composes its card: text fields (prefilled to review), single / multiple choices with
  the user's own answer, buttons for each alternative (the user's design).
- **Changed:** the relay requires sign-in (checks the Supabase session token); the chat uses three text
  sizes only, inputs included; the assistant's intro mentions the web.
- **Gotcha:** a run log line with class `tool` picked up the step tracker's `.tool` border — give nested
  items their own class names (`ev-…`).
- **Tests:** UI tests fake the model's streamed turns and the relay with Playwright routes, so the whole
  flow runs with no key and no cost.
- **First real session** (psychotherapist score, from an empty workspace): 2 scouts, 2 scrapers, 6
  sources, clean → join → scores → 3 layers. Fixed after it: a CSV missed because files return one by one
  (the scraper now lists its files and the app waits for them); a user visualization dropped by a stale
  workspace file (removal guard); findings lost between briefs; built-ins scraped from the web; a composite
  averaging measures that cover 17 of 51 states; tokens without dollars.
- **Changed (user):** built-ins are geographic only (`builtins/builtins.json`); the ACS tables are
  **samples** in the default folder (＋ Dataset → Samples), which the assistant doesn't see until added.
  Concept-first planning: for a score / index / ranking, the assistant defines what it measures (parts,
  ideal measures, directions, opposite readings) and has the user approve it before looking for data.

### Workspace files as a zip — 2026-10-29

- **Changed:** Download makes `<name>.powergis.zip`: the workspace document as small files in the
  agent's layout (`workspace.json`, `datasets.json`, a JSON and a `.sql` per transform output, a JSON per
  visualization with every setting, `overview.md`). Load takes the zip or the older JSON; Copy / Paste,
  the cloud and the default folders stay JSON. `fflate` zips (small, synchronous, works on iOS).
- **Setup's mini map** starts minimized to a ▴ Map bar (phone and computer); tap to open, ▾ to minimize.
- **Gotcha (iPhone):** after Safari downloaded a blob from a clicked link, the page ignored taps for
  the clipboard and the file picker until reloaded: Copy, Paste and Load stopped working, with nothing
  in the log. Files are now saved through `client/saveFile.ts`: the share sheet (Save to Files) on
  phones, a plain download elsewhere — the workspace zip, ArcGIS exports and the graph picture's fallback.
- **Gotcha:** a zip re-made from the unzipped folder holds everything under the folder's name (and on a
  Mac `__MACOSX/` and `.DS_Store`): Load looks through one top folder and skips those.
- **The agent's files are the same:** its visualization files hold every setting (checked part by part:
  color, opacity, pattern, outline, size; a field is always the drawn value) and `datasets.json` the
  document's facts with the structured origin (read-only). Download is only the zip.

### Agent: checking stages, re-running downstream, missing datasets; Copy graph as image — 2026-10-29

- **Agent prompt:** new sections *Checking each stage* (one row per key, joins keep their rows,
  values in range, unmatched keys reported) and *Visualizations people can read* (one question each,
  from the present stage, matching names and colors for a measure at two levels). It re-runs what
  depends on a transform it changed, never builds on a missing dataset (names it, points to
  Replace…), and its summary says which final datasets are worth linking (intermediates are remade
  anywhere). Naming rules live in one place. The overview says "missing on this device".
- **Checks computed by the app:** `run_transform` returns, per output, rows against the inputs',
  unique columns (keys), nulls, distinct values, ranges and flags, from the output's profile, so the
  agent checks every stage without spending queries on it. A separate reviewer agent was discussed:
  a bounded review pass at the end comes after scouting and scraping, not a back-and-forth loop.
- **Copy graph as image:** ⧉ in the graph's corner copies what its window shows as a PNG. Drawn on a
  canvas from the layout (browsers have no DOM screenshot; html-to-canvas tricks are unreliable on
  iOS Safari). **Gotcha:** iOS refuses a clipboard write that starts after an await, so the
  ClipboardItem is made at once with the PNG as a promise.

### Scout & scraper proof of concept — 2026-10-30

- **Added:** the assistant's ⚙ → *Test: scout & scraper*: runs a scout or scraper brief as an Anthropic
  Managed Agents session with the user's key and a spending cap; shows progress, cost, the report and
  output files (CSVs import as datasets). Decided: orchestrator / scout / scraper roles, all Python in
  Anthropic's container (no Pyodide), unrestricted web for both for now.
- **Relay:** the browser can't call Managed Agents (CORS, see Gotchas), so the calls go through
  `supabase/functions/managed-relay` (a Supabase Edge Function: forwards only Managed Agents paths, the
  user's key passes through, nothing stored), and the page polls session events instead of streaming.
  Tested through the local stack's gateway and edge runtime (`tests/cloud/relay.test.ts`).
- **First runs:** scout 39 s / $0.03, scraper 86 s / $0.02 (Haiku) — cheap. The scout guessed file
  layouts from names, so it now peeks at one file of each kind; the scraper test brief now needs Excel,
  a PDF table and a JavaScript-built page. The Census API needs a key now; the bulk Summary File
  (www2.census.gov) doesn't.
- **Checked:** the Home Depot earnings table read out of the PDF matched page 48 exactly (user).
- **CI:** the UI tests moved into the required `build` job after 14 green runs in a row as their own
  non-blocking job; they share the cloud tests' stack.
- **Plan (user):** next the assistant's own scout / scraper tools; then API keys asked for in the chat
  when a route needs one (an input card plus skip options, each with its alternative); run records;
  component cleanup; the reviewer pass later. Scheduled runs are a far-off nice to have.
- **Decided:** the assistant picks scout and / or scraper itself after weighing what the workspace
  already holds, and asks before searching; the test panel's role picker is only for the test.

### ＋ waits for the default map; sample values locked — 2026-10-29

- **Fixed:** on a first visit, a dataset added while the default map was still being prepared was
  dropped (the prepared map replaced the working copy). The ＋ buttons (graph and lists) now appear
  only once the workspace is ready, and hide again while Reset prepares it.
- **Tests:** the pipeline UI test checks the county and state sample values the user signed off,
  formatted in SQL (`printf`) so the cells compare as text.
- **README:** "How it's built": who designs, who codes, how it's tested.

### Default folders — 2026-10-29

- **Added:** `defaults/<folder>/`: each a complete starting map (`folder.json` listing its tables,
  their CSVs, `workspace.powergis.json`). `defaults/active.json` picks the one the app ships: its tables
  are the built-ins, its workspace the default map; other folders don't ship. Today only `socioeconomic`.
  `public/data/` is gone.
- **Removed:** the EIA-861 utilities data (its CSVs, `scripts/build_utility_counties.py`) and the demo
  vector field. The utilities map will be rebuilt as a folder with the app's own tools. Its workspace
  stays as a unit-test fixture over made-up tables (`tests/fixtures/utilities-join.powergis.json`).
- **Why in the repo, not a data branch:** a build reads the folder at build time, so a separate branch
  would need a fetch step in every build (Netlify, CI, local) and could drift from the code that reads
  it. A few MB of CSVs is fine in git; a folder too big for that can later be fetched by the same plugin.
- **Gotcha:** a workspace that names a built-in only another folder has opens with that dataset missing
  ("a built-in table this version of the app doesn't have"), like any missing dataset.

### Default map: the socioeconomic pipeline — 2026-10-29

- **Changed:** the default map is the user's socioeconomic pipeline (six ACS county tables, now
  built-ins, ten transforms, twelve visualizations) instead of the EIA utilities map. The EIA tables
  stay built-ins and the old default is a test fixture. A first visit also downloads the spatial
  extension (land area for the state averages).

### UI tests in CI — 2026-10-29

- **Added:** `tests/e2e`: the app in a browser against the local Supabase stack, on every PR. Your
  socioeconomic pipeline (load, replace six uploads, run ten transforms, check rows and values) and
  five two-person scenarios (second device, read share used as input, two writers and a conflict,
  access lowered and leaving, signed out), with values checked against the same SQL run outside the
  app. Stable test keys (`data-testid`) on the controls they use.
- **Non-blocking for now:** they run as a second CI job, `ui-tests`, which the branch ruleset doesn't
  require: ✓ / ✗ on every PR, but a red one doesn't stop a merge. Build, unit and cloud integration
  tests stay required in `build`. After about 10 green runs in a row the UI tests become required too.
- **Gotchas:** graph nodes outside the graph's view can't be tapped until it's panned (tests use the
  List view); opening an account's workspace pops the Workspace panel open a moment later, over the
  page (tests wait for its message, then close it); Explore shows numbers without separators.
- **Data note (from the fixtures):** Connecticut gets no ACS county values: the 2022+ ACS reports its
  nine planning regions, the shapes (and EIA) its eight old counties.

### Cloud integration tests on a real Supabase stack — 2026-10-29

- **Added:** `tests/cloud` runs the real cloud code as three real accounts against `supabase start`
  (Docker, no account), in CI's `build` job: two devices of one user (link, pull, push, conflict,
  overwrite, rename), sharing (read / write, the rules checked in the database directly, leaving,
  delete from the cloud) and private workspaces.
- **Fixed (found by it):** deleting a cloud dataset without owner access "succeeded": row-level
  security skips the row without an error. `deleteDataset` now asks for the deleted row back and
  refuses when none comes (the app already checked ownership first, so the UI never hit it).
- **Dead end:** loading DuckDB extensions in the Node test engine (duckdb-wasm's blocking Node
  build) hangs, from a URL or a local path. Tests that need spatial run in the browser instead.
- **Gotcha:** the Supabase CLI pulls its images from AWS's public registry by default; where that's
  blocked, `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io` uses Docker Hub's copies.

### Agent: pipelines people can follow — 2026-10-29

- **Changed:** the assistant builds transforms in stages (clean each input, join, compute,
  aggregate, present), as many small steps rather than one large query, with stage-numbered names,
  one-line descriptions and commented SQL; visualizations are named with their unit, and only the
  main one starts visible. Asked for a socioeconomic score, it had made two large joins that were
  hard to follow.
- **Fixed:** its instructions still said cloud datasets were read-only to it and suggested moving
  datasets to protect them; since cloud links, it changes copies here and the user syncs.

### Sharing (Supabase, PR 4 of 4) — 2026-10-29

- **Added:** **Share…** on a cloud dataset: its people, add someone by their account's email as **Can
  pull** (read) or **Can push** (write), change a level, remove someone, or **Leave**. What you may do
  follows your access (the owner manages everyone; pushers share and manage readers). People find what's
  shared with them in **＋ Dataset → Cloud**, which adds a copy linked to it.
- **Gotcha:** row-level security doesn't fail a forbidden UPDATE or DELETE, it matches no rows. The
  app asks for the changed rows back and treats none as refused, and checks the same rules first
  (`canManage`) so it can say why.

### Cloud datasets (Supabase, PR 3 of 4) — 2026-10-28

- **Added:** cloud links. The app always works on copies on this device; signed in, **Link to cloud**
  gives a dataset a cloud copy, and it syncs only when you do: **Push** (this copy → cloud) and
  **Pull** (cloud → this copy), from a review panel with Push · Pull · Skip on every line (the ones that
  don't apply greyed out, with the reason). Cards show Cloud, Cloud ↑ (changed here), Cloud ↓ (newer in
  the cloud) and Cloud ↑↓ (both); the app checks on open and every minute. Unlink, Delete from the
  cloud; Link to cloud… and Sync all… in the Workspace panel. Other devices pull linked datasets when
  they open the workspace. Owner / write push, everyone pulls.
- **Fixed:** the worker could hold a stale or missing sign-in and act signed out: every cloud request
  re-sends the current one first; a workspace save that didn't reach the account is sent on the next
  load instead of the older account copy opening over it.
- **Dead end:** Parquet files. DuckDB-WASM reads and writes Parquet only through its parquet
  extension (not built in; autoload is off on purpose), which every device would download, and this
  sandbox can't reach DuckDB's extension server to test it. Rows go as gzip-compressed Arrow IPC
  instead: columnar, small, and read without the SQL engine.
- **Lesson:** design changed three times (cloud-first datasets with drafts → local-only working copies
  → plain local copies with manual sync). The last is the simplest: one rule (the app works on local
  copies), one link per dataset, and sync as the only door to the cloud.

### Dataset details as a draft — 2026-10-28

- **Changed:** a dataset's new name and description are an unsaved change like any workspace edit:
  shown at once, written to the dataset on Save, undone by Discard (`doc.datasetEdits`).
- **Changed (assistant):** it renames and describes datasets in `/datasets.json` (name and
  description editable; store, rows and origin read-only; cloud datasets refused), applied with
  `apply_workspace`. The `update_dataset` tool is gone.

### Signed-in indicator — 2026-10-28

- **Added:** signed in, the ☰ menu button is outlined in green (its tooltip names who) and the menu's ◉ account icon turns green.
- **Changed:** signing in closes the account window instead of showing your profile.

### Unavailable items — 2026-10-28
- **Added:** a workspace opened on a device that lacks some of its datasets keeps them, and everything
  waiting on them, in red (graph outline, ⚠ on the missing datasets, a red line in the lists), saved
  along. Replace a missing dataset with a file or another dataset (it takes over every pointer), then
  Run them now; or Remove what didn't load.
- **Fixed:** saving on such a device used to drop the missing datasets, and what used them, from the
  account's copy.
- **Added:** Replace… on any dataset (Edit → ⇄ Replace…, the usual add-dataset panel with a working
  Cancel; what it adds takes the old one's place everywhere, as a draft), and
  the "Only on this device" list and Save note when signed in.
- **Lesson:** keep what you can't use, with what you know of it. The v2 document's dataset facts made
  this cheap: the missing entries carry their name, rows and origin through any number of saves.

### Cloud workspace (Supabase, PR 2 of 4) — 2026-10-28
- **Added:** signed in, Save also stores the workspace in your account; another device opens it,
  rebuilding built-in tables and transform outputs there. The Workspace panel says where changes are
  saved. Uploaded datasets don't travel yet (PR 3).
- **Decision (revised before merge):** the first version saved a *template* (`builtin:` / `transform:`
  placeholders, a `names` side table, outputs marked with SQL + inputs). Replaced by a v2 document that
  simply states each dataset's facts (name, store, rows, origin) next to the real ids; opening reflects
  what's here and what isn't, without tricks. Copies remember the ids they stand for (`copyOf`), and
  every output records the SQL that wrote it, so reuse is checked rather than guessed.
- **Decision:** the worker, not the page, talks to Supabase for data (lasting changes stay server
  side); the page hands it each access token. Accounts stay in the page.
- **Gotcha:** the default map's transforms ran in file order; a template saved from a real workspace
  can list a transform before the one whose output it reads, so `openDocument` runs whatever's ready
  until nothing more is.

### Accounts (Supabase, PR 1 of 4) — 2026-10-28
- **Added:** sign up / sign in with email and password, forgot password (reset email), your profile
  (display name, change password, sign out, delete account) under ☰, and a note on the sign-in screen
  about what's kept without an account. The whole Supabase schema for the next three PRs
  (`supabase/schema.sql`) with its RLS rules.
- **Decision:** email + password over magic links. Signing in sends no email (the built-in sender
  allows only a few an hour), and on an iPhone a link from an email opens Safari, not the home-screen
  app.
- **Decision:** dataset rows as Parquet files in Storage, not a Postgres table per dataset: the REST
  layer can't make tables, must be told about each new one, and pages rows ~1,000 at a time; DuckDB
  reads one Parquet download directly.
- **Gotcha:** this sandbox's proxy refuses supabase.co (403 on CONNECT), so auth can't be exercised
  here. The schema was tested on a local Postgres 16 with stand-in `auth.uid()` and `storage`
  instead; sign-in is checked on the preview.
- **Gotcha:** the publishable key can't delete accounts (`auth.admin` needs the secret key). A
  security-definer `delete_my_account()` deletes only `auth.uid()`'s row; storage files can't be
  removed from SQL, so the app deletes them through the Storage API first.
- **Gotcha:** an insert's `RETURNING` is checked against the SELECT policy before an AFTER trigger's
  rows exist — so "see datasets you have access to" also needs `created_by = auth.uid()`, or
  `.insert().select()` fails for the creator.

### Fix: "save workspace: Call init first" after a new deploy — 2026-10-28
- **Symptom:** on the first load after each new deploy, Save failed with *Call init first*; a reload
  fixed it until the next deploy.
- **Cause:** the server worker only learned the device's local user from the page's one `init`. When
  the worker restarted after that (`client/api.ts` makes a new one after an error), the new worker had
  no user, and saving a first workspace needs one.
- **Fix:** the server finds or makes the local user on first need (`ensureUser`, used by `init` and
  `saveWorkspace`); the client re-sends its `init` first to a restarted worker and logs *server
  stopped (…)* with the reason, so the next report names what stopped it.

### Explore and setup modes — 2026-10-28
- **Added:** two page modes. Explore: map first, search above it, export below it; desktop keeps the side
  panel. Setup: one panel headed by List | Graph | ✕, the open item in its own section (right column on
  desktop, under List | Graph on phones), and a mini map whose height is dragged. The page fits the
  screen; only panels scroll. ☰ menu (Help, Desktop / Phone view); one-row footer; legend top-left.
- **Removed:** the ⤢ pop-out window, and editors opening inline inside cards (they open in the
  open-item section now, in both views).
- **Lesson:** stage layouts as screenshots before building. Layout feedback came in several rounds
  (where the Set up bar goes, where ✕ sits, what scrolls); each round was a CSS change, not a rebuild,
  because the modes only move the same components between grid areas (`display: contents` on the
  panel body lets its parts take separate areas in setup).
- **Gotcha:** a sticky element inside a scrolling page hides what `scrollIntoView` brings in. The
  phone's setup has a sticky head and a sticky mini map, so the page sets `scroll-padding-top` /
  `-bottom` to match, or revealed cards land under the map.
- **Gotcha:** MapView's own `min-height` (meant for the full map) pushed the mini map and an open
  Export panel off the page; the mini map lifts it.

### Client / server audit — 2026-10-28
- **Moved to the server:** seeding the default map (was ~10 client round trips of server logic),
  reading rows for the transform editor's input preview (it read the whole table to show 20 rows),
  and building exports. The client's database handle no longer has `readRows`, and a test scans
  client code for server-only imports and stray `fetch` calls, so the boundary is enforced rather
  than a convention.

### Agent: the workspace as files — 2026-10-28
- **Changed:** the agent no longer resends the whole workspace (`update_workspace`). With Haiku that
  payload — SQL inside JSON inside the tool call — came back as one JSON-encoded string twice; the
  retry that passed had dropped a transform and sent `visualizations: []`, removing every
  visualization. It now edits small staged files with Anthropic's text editor tool and commits with
  `apply_workspace`.
- **Lesson:** don't invent an edit protocol when the model is trained on one. An intermediate design
  (exact replacements on one JSON text with `${…}` tokens for SQL) worked but had two kinds of token,
  and the agent named its new SQL `sql:new.o1`, which read as the other kind. Files with naming
  conventions (`<id>.<key>.sql`) leave nothing to mix up.
- **Lesson:** return the ids of what a tool creates. Without them the agent called
  `run_transform("PLACEHOLDER")`.
- **Gotcha:** an Anthropic-defined tool (the text editor) is declared by type only — any description
  we write isn't sent. Teach what the model needs elsewhere (here: the overview). And keep refusal
  hints factual: a suggested path with a guessed output key could send the agent to rename a real one.
- **Gotcha:** with strict tools, an optional field is one the model may leave out. `query_sql` briefly
  took `sql` *or* `sqlFile`, both optional; Haiku sent the same call without either three times.
  Whatever a tool can't work without is `required` — no either/or pairs.
- **Gotcha:** DuckDB-WASM prints a parser error's "LINE 1: …" excerpt twice, and for a wrapped query
  (paging) the excerpt shows our wrapper. We re-plan the bare query with `EXPLAIN` for the message.

### Spatial extension — 2026-10-28
- **Added:** DuckDB's **spatial** extension (ST_Area_Spheroid, ST_Transform, spatial joins, ST_Read…),
  on an allowlist (`shared/sqlExtensions.json`). A query that names an extension's function fails with
  "…exists in the spatial extension"; the runner loads it (if allowed) and runs the query again.
  `autoload_known_extensions` is off, so nothing loads outside the allowlist. GEOMETRY results come
  back as GeoJSON text (`DESCRIBE`, then `ST_AsGeoJSON` in a wrapping SELECT), so they're geometry
  columns like any other.
- **Workspace dependencies:** a run records the extensions its SQL used (`transform.requires`, from
  the functions each extension added that the SQL calls — not type names: `geometry` is our usual column
  name, and matching it made every transform "need" spatial); the workspace's are the union (in workspace files as
  `requires`), loaded in the background as soon as a workspace needs them.
- **Hosting:** the Netlify build downloads the extension into `public/duckdb-ext/` (`prebuild`,
  `scripts/fetch-duckdb-extensions.mjs`); the app falls back to `extensions.duckdb.org` when the copy
  is missing (a missing file comes back as the SPA's HTML, so the check looks at the content type).
- **Not verifiable from the dev sandbox:** `extensions.duckdb.org` is blocked here, so the real load
  was only tested on the preview. Tests use a stand-in extension.

### Engine speed — 2026-10-27
- **Fixed:** queries slowed down over a session. The engine cached loaded tables **by alias**, and the
  agent invents a new alias for nearly every query, so each one reloaded the whole dataset (a 3,071 ×
  330 Zillow file took ~11 s as `INSERT … VALUES` text) and old copies were never dropped. Now: one
  copy per dataset (aliases are temp views), bulk load as an Arrow IPC stream (~0.5 s), an LRU cell
  budget, queries serialized, paged queries run once (`count(*) OVER ()`).
- **Gotcha:** `insertArrowTable` with a Table built by a different copy of apache-arrow (our import vs.
  DuckDB's own, in the Node build) silently creates nothing. Pass bytes (`tableToIPC` →
  `insertArrowFromIPCStream`) instead. `apache-arrow` is pinned to DuckDB-WASM's version (17.0.0).
- **Fixed:** renaming or describing a dataset no longer bumps `updatedAt` (transforms stayed "stale").
- **Agent:** re-reads the workspace when something expected is missing, before offering to search
  other datasets.

### Assistant: dataset processor agent — 2026-10-27
- **Added:** ✦ Assistant (header): a chat with an agent that studies the workspace's datasets,
  writes and runs transforms, and sets up visualizations, through its tools (`get_workspace`,
  `list_datasets`, `ask_user`, `query_sql`, `update_dataset`, `update_workspace`, `run_transform`, `delete_dataset`) that call the page's own
  functions. The user's own Anthropic API key, stored on the device; calls go straight to Anthropic
  from the browser (`claude-opus-5-5`, streaming, server-side fallbacks, prompt caching).
- **Added:** one dataset finder, `listDatasets()` (`client/datasets.ts`), behind ＋ Dataset → Saved,
  the default map's seeding and the agent's `list_datasets`; the prompt names no datasets. The agent
  starts from the workspace and confirms its plan with `ask_user` (Approve / Reject card + notes);
  it looks at datasets outside the workspace only when the user agrees.
- **Added:** model choice in the assistant's settings (Opus 5.5 default; Fable 5.1, Sonnet, Haiku and
  older models), fixed for each chat: a new choice applies from the next chat.
- **Added:** screenshots in the chat (paste or 📎; shrunk to 1,568 px JPEG); `visualization_stats` and
  data-aware styling rules (log scale as a setting, centered diverging maps, clipping domains;
  legend marks clipped ends); a log scale now starts at the smallest positive value. Default model
  Haiku 5.5. The assistant docks on the right on desktop, resizable (`useSplitter`).
- **Added:** `UiButton` with sizes (tag / compact / regular / large) and tones: glyphs drawn larger
  than text and tight padding; pills, header, icon and assistant buttons moved to it. **New chat**
  is a labeled button that confirms (a ＋ read as "add", but it clears the conversation).
- **Fixed:** a long `update_workspace` input from Haiku ended in stray characters and the step failed
  with a raw JSON dump. Eager input streaming is off (the API validates tool inputs again), kept
  items can be sent as `{id}` (smaller inputs), and the error now reads in plain words with the
  details folded away. "Remote" storage is called **cloud** everywhere users see it.
- **Fixed:** Stop only took effect between steps, so a hung request or slow tool held the chat (and
  New chat was disabled while busy). Now every step is raced against Stop (`untilStopped`), and New
  chat stops the run first.
- **Added:** the server refuses an agent's (`caller: 'agent'`) changes to remote datasets.
- **Design:** a provider-neutral loop (`lib/agent/`) with an adapter per AI provider; tool inputs are
  validated before anything runs, and a workspace update is all-or-nothing with every problem
  listed for the model. Visualizations travel in a compact form filled from the app's defaults, so
  the model never writes full style JSON.
- **Tested:** tools and loop with a fake host and scripted model; the Claude adapter against a fake
  streaming API (request shape, history, pause / truncation / Stop); end to end in a headless
  browser with the API stubbed (real DuckDB queries and workspace edits). Not yet tested against
  the real API from here (no key in the sandbox).

### Dataset stores + copy / paste workspace — 2026-10-27
- **Added:** every dataset has a store, **Local** (this device) or **Remote** (shared database,
  later), shown on its card. **Move to remote storage** exists and answers that remote storage
  isn't available yet. **Delete dataset** on the card (not while a transform reads it).
- **Added:** **Copy workspace** / **Paste workspace…** in the Workspace panel: the workspace file's
  JSON through the clipboard. Paste opens a box filled from the clipboard (iOS asks with its Paste
  bubble), so a wrong clipboard is fixed by Clear and paste again.
- **Docs:** `docs/agents.md`, the agent design: one in-app agent, the user's own API key on the
  device, six tools (read anything; change only local datasets, also enforced by the server),
  profiling by `SUMMARIZE` rather than a profile tool. Replaces the Managed Agents plan.
- **Found:** the planned "query speed-up" was already there: loaded tables stay in DuckDB until
  their dataset's `updatedAt` changes.

### Run all stale — 2026-10-26
- **Added:** ↻ Run all stale (graph toolbar and list Transforms panel): every stale transform plus
  everything downstream, writers before readers, one by one, stopping at the first failure.
- **Changed:** the transform editor is compact — one line per input / output — with a sticky,
  collapsible preview dock: tap an input for its rows, an output for what its SQL makes.
- **Added:** double-click / double-tap a card opens it (Explore / editor); visualizations' checkbox
  became a Visible / Hidden pill. Decided: **cards only** — graph nodes keep tap = select / tap again = deselect. A single tap already opens the node's
  card, which shifts the layout between the two clicks (scroll anchoring moved a node 31 px), so a
  double-tap there was timing-dependent. `overflow-anchor: none` on the side panel and pop-out.
- **Added:** **Explore** replaces a dataset's Preview: a SQL window over the dataset (and the
  workspace's others, by table name) with paged results, 200 rows a page. Made for checking joins —
  e.g. which rows of an upload find no county.
- **Fixed:** a card's hold / right-click menu was clipped by its scrolling container (side panel,
  pop-out detail column). It now floats over the page (teleported, fixed at the press point).
- **Changed:** Search is docked at the top of the side panel and more compact.
- **Docs:** CLAUDE.md, system-design (Graph view), help overview, TODO.

### Graph layout + panel UI — 2026-10-26
- **Changed:** the DAG ordering minimizes arrow crossings — edges that skip rows get virtual points
  (their own lane in each row, drawn through), then alternating barycenter sweeps with neighbour
  swaps keep the fewest-crossings order. The default map's state-borders arrow no longer crosses the
  others.
- **Added:** ↓ / → flips the graph between top-to-bottom and left-to-right (per device); a desktop
  splitter makes the side panel resizable (per device); ⤢ pops the workspace panels (List | Graph to
  just before Export) into a large modal via a disabled-when-docked `Teleport`, so state survives.
- **Changed:** Find is now a separate Search card reading "Search in [viz] in [All data / column]";
  ＋ Dataset / ＋ Transform / ＋ Visualization are pills in their node colors.
- **Changed:** the visualization form says what each choice does — **Shapes** (geometry column),
  **Name shapes by** (title only), **Value to show** (what colors it) — with a hint under each.
- **Added:** in the pop-out, the open graph item sits right of the graph; new-item flows scroll each
  step into view (`v-reveal`).
- **Changed:** **dark only**, from bitcoin-explorer's palette: slate surfaces, blue for interaction
  only, violet datasets / orange transforms / green visualizations, amber attention with a mark
  (stale transforms get a ↻ badge), orchid Search matches, dark basemap (OpenFreeMap dark → CARTO
  Dark Matter → plain). Colour literals replaced by tokens (`vars.css`) and `lib/mapTheme.ts`.
- **Fixed:** the Search card overflowed the desktop side panel (its grid column needed `minmax(0, 1fr)`).
- **Fixed:** labels over the data were dark-on-pale and muddy, and roads cut across the data: the
  dark style puts some water labels before its roads, so slotting data under "the first symbol
  layer" sank it below the roads. Data now goes under the trailing run of label layers, and those
  labels are repainted light with a dark halo.
- **Added:** the graph pans and zooms instead of scrolling — drag; Shift + wheel / pinch; on phones
  hold-then-drag and two-finger pinch, so a one-finger swipe still scrolls the page.
- **Changed:** the default workspace is named **PowerGIS** (was "Electric utilities by county
  (EIA-861)"); saved workspaces keep their names.
- **Changed:** the workspace bar left the side panel: a **Workspace** button in the header (amber ●
  while unsaved) drops down the name, counts, Save / Discard and file actions (a sheet on phones).
  `<Teleport defer>` puts it in the header (the target is rendered by App in the same pass).
- **Changed:** list panels in the graph's order of attention — Visualizations, Transforms, Datasets —
  with the same compact ＋ pills as the graph (global `.kind-pill`).
- **Changed:** ＋ Dataset / ＋ Transform / ＋ Visualization are compact pills like bitcoin-explorer's
  `.toggle`: thin kind-coloured border, 12% tint, kind-coloured 0.68rem text, 1rem radius.
- **Fixed:** on iOS the map grew as you started scrolling, and only then did the page move: its
  height was `70dvh`, which tracks Safari's collapsing address bar. Now `70svh` (small viewport,
  stable). **Use `svh` for in-page heights on phones; `dvh` only for full-screen overlays.**
- **Lesson:** a global form-control rule must sit in `:where(…)` — `input:not(…)` chains outrank
  scoped component rules and silently restyle every field.
- **Lesson:** MapLibre only resizes with the window — a splitter or modal changes its container
  without a window resize, so `MapView` watches the container with a `ResizeObserver`.
- **Docs:** CLAUDE.md, system-design (Graph view, Side panel, Find), help overview, TODO.

### Graph view (DAG) — 2026-10-26
- **Added:** List | Graph switch. The graph (`lib/workspace/dag.ts`, `components/dag/DagView.vue`)
  shows datasets → transforms → outputs → visualizations, laid out automatically (rows by depth,
  barycenter order); tap a node to open it under the graph; ＋ Transform by tapping input datasets;
  ＋ Visualization by tapping a dataset; transforms marked not run yet / needs re-run.
- **Decided:** automatic layout only for now (no saved positions); tap-to-pick inputs (no edge
  dragging); visualizations are nodes. Tapping a node shows its card (hold for options) — editors
  open only for new items. One writer per dataset: a transform's Writes to (new / an unclaimed
  dataset); deleting a transform keeps its output, re-linkable by another transform. Transform menu
  gained Preview.
- **Changed:** transforms are inputs + outputs (one SQL per output; Run writes all, or none if one
  fails). Old single-SQL transforms are read through `normalizeTransform`. **＋ Dataset** joined the
  graph's toolbar (the separate Add dataset button under the graph is gone). The List view opens
  with every panel collapsed, and ＋ Add dataset sits at the top of its panel like the others. Graph
  is the default view; the List | Graph choice is remembered per device.
- **Fixed:** the transform editor could widen the whole controls column past a phone's screen (a
  grid's auto column grows to its widest child) — `minmax(0, 1fr)` on the page grid and the editor.
- **Docs:** CLAUDE.md, system-design (Graph view), help overview, TODO.

### Object lists: hold menus for datasets, visualizations, transforms — 2026-10-26
- **Added:** `components/list/ObjectList.vue` — a generic card list fed `items`, a card slot and
  `actions(item)` for its tap-and-hold (right-click) menu; built-in Reorder (≡ handles, vertically
  centered, until Done). Datasets, visualizations and transforms all use it.
- **Changed:** no buttons on cards. Datasets: Preview / Edit / Copy id / Reorder / Remove.
  Visualizations: Edit / Zoom to data / Reorder / Delete (swipe-to-delete removed; the visibility
  checkbox stays). Transforms: Run / Edit / Delete. Zoom to data moved from datasets to visualizations.
- **Fixed:** after a reorder, the moved card stayed highlighted on iOS — moving the row in the DOM
  drops the handle's pointer capture, so the release was never heard. `useDragReorder` now also
  listens on the window during a drag, and Done ends any drag.
- **Lesson:** iOS Safari fires no `contextmenu` on a long press — a pointer-event timer
  (`useLongPress`) with a 10 px move slop (so scrolling cancels) plus `-webkit-touch-callout: none`.
- **Docs:** CLAUDE.md, help overview, system-design.

### Boundary datasets + data-agnostic default map — 2026-10-26
- **Added:** built-in boundary datasets `us_counties` / `us_states` (region geometry from us-atlas);
  normalized EIA-861 tables (`utilities` identity, `utility_counties` links); the
  default workspace file `public/data/default.powergis.json` (placeholders `builtin:<table>` /
  `transform:<n>`, resolved by `seedDefault`); a feature-name column in the geometry binding (`label`).
- **Removed:** the region-code binding (`kind: 'boundary'`, `includeEmpty`, client boundary loader),
  `UtilityCountyDashboard`, `utilityStyles`, `lib/utilities.ts` (ownership flags, typed rows), the
  `preset: 'utilities'` extension. Old saved visualizations of the removed kind are dropped on open
  with a note pointing at ⋯ → Reset. Clicking a county now shows the generic rows table.
- **Fixed:** the misleading `counties_in_state` column is gone (count links in a transform instead).
  Customers / sales / revenue dropped for now (a separate built-in later, at EIA's utility × state
  grain).
- **Lesson:** a stored copy of a built-in must carry a version, or a device keeps feeding the old
  columns to a new default transform (`extensions.version`).
  `checkSelect` counted semicolons inside comments and strings as statement breaks; a trailing
  `-- comment` swallowed the `)` of the preview wrapper.
  `sum()` of integers (DuckDB HUGEINT) and DECIMAL results came back as raw Arrow big numbers —
  now plain numbers, scaled from the type (`plain()` in `server/sql.ts`).
- **Lesson:** a join copies a county's shape onto every utility row; grouping stays cheap by
  parsing repeated GeoJSON text once and keying shared geometry objects by identity.
- **Cost:** the first visit loads DuckDB (~8 MB gzipped) to run the default join (~6 s on a desktop);
  later visits reuse the stored output.
- **Docs:** CLAUDE.md, README, system-design (geometry binding, boundary datasets, Default
  workspace), help overview, TODO.

### Transform inputs + dataset preview — 2026-10-26
- **Added:** Insert button and alias rename-in-SQL for transform inputs; readable missing-table
  errors; dataset row preview (▤); copy dataset id (⧉); searchable input picker (name, typo-tolerant
  fuzzy search, or id).
- **Removed:** "Find a utility" (utility-specific) — replaced by **Find**, which searches any
  visualization's feature names and row values (all data or one column) and highlights + zooms like
  the old search did.
- **Changed:** `point(lat, lon)` — latitude first (was `point(lon, lat)`); transforms written
  with the old order now put points in the wrong place and need their arguments swapped.
- **What didn't work:** naming SQL tables by dataset id (`ds_<uuid>`, inputs as bare ids) — built
  and dropped in favour of the `{datasetId, alias}` pairs, which read better in SQL. Also: a string
  `ref` on an element inside `v-for` is an array, so the SQL textarea uses a function ref.

### Transforms + profiles — 2026-10-26
- **Added:** SQL transforms on DuckDB-WASM (preview, run, saved with the workspace and in files);
  `point(lon, lat)` / `vector(u, v)` helpers; dataset profiles on every write.
- **Changed:** workers build as ES modules (`worker.format: 'es'`), needed for the on-demand DuckDB
  import; visualization values are keyed by the dataset's `updatedAt`.
- **What didn't work:** loading inputs with `registerFileText` + `read_json` hung DuckDB's Node build
  (tests), so inputs load with `INSERT … VALUES` batches everywhere. A dev-tagged DuckDB release is
  `latest` on npm; pinned the stable 1.32.0 instead.
- **Docs:** CLAUDE.md, system-design §4 (transforms, profiles), help overview, TODO.

### Geometry columns — 2026-10-26
- **Added:** point / polyline / region column types; the demo vector field carries a point column.
- **Removed:** lat/lon visualization bindings — saved ones are dropped with a log line; the
  dataset editor's "Combine two columns into a vector" — deriving columns (lat/lon → point,
  u/v → vector) is left to SQL transforms (step 2). A brief auto point column at upload and an
  "Add a column" form were built and dropped before merge for the same reason.
- **Changed:** default visualizations skip latitude / longitude columns as values.
- **Docs:** CLAUDE.md, system-design §4, help overview, TODO roadmap (1c, step 3 data-agnostic).

### Categorical palettes — 2026-10-25
- **Added:** 12 / 24 / 60-color, Many and Auto palettes (`lib/palettes.ts`); palette picker.
- **Removed:** the 9-category cap and grey "other" bucket; values are colored in sorted order
  (was frequency order).
- **Lesson:** a pure max-min color picker drifts to neon primaries next to Tableau's muted tones;
  capping chroma (22–62) keeps one family at a small cost in minimum distance (22.6 → 17.6 ΔE).

### Explicit Save + workspace files — 2026-10-25
- **Added:** workspace bar with Save / Discard and an Unsaved-changes marker; drafts survive
  reloads; workspace file download / load (pointers + settings only); rename the workspace.
- **Changed:** no more autosave; Reset produces an unsaved default map instead of deleting the
  workspace.
- **Lesson:** a text input's default ~20-character width made the sidebar 20px wider than a
  390px phone; flex inputs need `width: 0; min-width: 0`.
- **Docs:** CLAUDE.md, system-design §4, help overview, TODO.

### Client / server boundary — 2026-10-25
- **Added:** server in a Web Worker with typed requests; IndexedDB database (base tables + one data
  table per dataset); read-only client database access; per-visualization geometry binding;
  "Saved" datasets list; vector columns added from the dataset editor.
- **Changed:** visualization values are computed server side; workspaces store pointers only;
  datasets are shared records that outlive workspaces. The step-1 localStorage/IndexedDB save
  format is dropped — the first open starts from the default utilities map.
- **Lesson:** Vue reactive proxies can't be posted to a worker (`DataCloneError`); `request()`
  unwraps payloads to plain data first.
- **Docs:** CLAUDE.md, system-design §4, help overview, TODO.

### Workspace + persistence — 2026-10-25
- **Added:** workspace document and operations layer (`lib/workspace/`); datasets and
  visualizations saved on the device and restored on open; rename / describe / drag-reorder
  datasets; Reset workspace.
- **Changed:** the visualization visibility checkbox now goes through `updateVisualization`
  instead of mutating the spec; drag-to-reorder extracted to `useDragReorder`.
- **Defaults:** first open (or after Reset) seeds the EIA-861 utilities dataset as before.
- **Docs:** system-design §4 Workspace, CLAUDE.md, help overview, TODO.

### v0.1.0 — [Date]
- **Added:** Initial scaffold, header/footer wrapper, Help modal
- **Infrastructure:** Netlify (production + preview deploys), branch-protected `main`
- **Docs:** TODO, experience, system-design, concepts scaffold

---

*Tip: When you abandon a branch or realize something didn't work, add a short "What didn't work" entry above so future-you (or a teammate) doesn't re-walk the same dead end.*

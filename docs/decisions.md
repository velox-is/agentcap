# Decisions

Ambiguities found in the v0.1 handover, with the resolution taken and why. Logged here per session protocol; work proceeds without waiting.

## D1 — `agentcap init` does not scaffold a config with a fake provider
Handover says `init` writes config. It does not say whether a sample provider is pre-filled. `init` writes `agentcap.config.json` with empty `providers`/`pricing` plus `agentcap.config.example.json` containing a filled OpenAI-compatible block. Reason: an empty providers map cannot mislead the owner into thinking a model resolves; the example file carries the shape. `start` with empty providers boots fine (milestone 1 has no routing yet).

## D2 — config carries an optional `bind`, validated to 127.0.0.1
Handover says bind 127.0.0.1 only, refuse 0.0.0.0, and fixes ports. It gives no config key. Added `bind` (default `127.0.0.1`) and a hard reject of anything else at load time so the refusal is enforced, not documented. Ports are config keys defaulting to 4100/4101/4102 and must be distinct.

## D3 — SQLite lives at `.agentcap/agentcap.db`
Handover does not name a DB path. Chose a gitignored `.agentcap/` dir under CWD so the DB is per-repo (agentcap instruments a project, not the machine) and a clean clone stays clean.

## D4 — migrations tracked in `_migrations`, applied in filename order
"Migrations as numbered .sql files" implies idempotent application. A `_migrations` table records applied names; each file runs in its own transaction. No down-migrations in v0.1.

## D5 — `crypto.randomUUID()` for ids, no dependency
Node 22 exposes it globally. Keeps the dependency list inside the fixed stack.

## D6 — health routes on every server from milestone 1
`GET /health` returns `{ok:true,service:<name>}` on proxy, otel, dashboard. Not in the handover; needed to prove the boot in milestone 1 without a UI or a proxy path. Dashboard serves a static placeholder page until milestone 5.

## D7 — `task new` and `task kill` work without the server running
They open the DB directly rather than calling an HTTP endpoint. SQLite WAL plus `busy_timeout=5000` makes a second writer safe. Reason: a kill switch that needs a live server is not a kill switch.

## D8 — task status set to `killed` by the CLI immediately
Handover says in-flight requests finish their current chunk then close. The CLI flips status to `killed` at once; the proxy reads that status to decide the close.

## D9 — build bundles CLI with esbuild, migrations and assets copied to dist
The handover requires `npx agentcap` to work, so the CLI must be a single bundle. `better-sqlite3` stays external (native addon). Migrations resolve relative to the module at runtime with a dev fallback so both `dist/` and `tsx src/` paths work.

## D10 — no Hono, plain `node:http` routers
Routing is still a handful of literal path checks. Hono stays uninstalled until routing is genuinely ugly.

## D11 — better-sqlite3 pinned to ^13, not ^11
The host runs Node 26.13.1 (V8 14.6). better-sqlite3 11.x fails to compile against that V8 (`no member named 'GetPrototype'`, `no member named 'This'`). Bumped to 13.2.0, which builds clean. Same library, so the fixed-stack rule holds — no new dependency, only a major version.

### D11 verification (owner conditions)
Prebuilds: 13.x dropped `prebuild-install` and moved to N-API, so binaries are ABI-independent and shipped inside the tarball. `npm pack better-sqlite3@13.2.0` contains 8 prebuilds — darwin-arm64, darwin-x64, linux-x64, linux-arm64, linuxmusl-x64, linuxmusl-arm64, win32-x64, win32-arm64. `lib/binding.js` resolves `build/Release` first, then `prebuilds/<platform>-<arch>.node`; `gypfile:false`, so npm does not run node-gyp when a prebuild exists. Verified empirically: `node_modules/better-sqlite3/build/` does not exist after install on this machine (Node 26, ABI 147) and the module loads against the darwin-arm64 prebuild. All three required platforms have prebuilds, so the compile risk is closed, not deferred.
Engines floor: `>=22`. Node 22 is in range, so the floor does not exclude the handover's stated minimum. Node 18/20 are excluded; the README states Node 22+.
API breaks from 11 to 13: 12.0.0 dropped EOL Node 18 and old Electron; 13.0.0 is the N-API rewrite (node-addon-api) and removes the deprecated `prebuild-install` dependency. Surface used here (`new Database`, `.pragma`, `.prepare`, `.run`, `.get`, `.all`, `.transaction`, `.exec`, `.close`) is unchanged. Added in 13: `db.explain()`, `preparedStatement.toString()`.

## D12 — `node:sqlite` is the fallback if better-sqlite3 prebuilds ever regress
Node 22+ ships `node:sqlite` in core. Switching removes the native module entirely and kills this bug class permanently, at the cost of rewriting `src/store/` and re-checking every better-sqlite3 call site. Not switching now — it is a mid-milestone rewrite. Revisit if a future better-sqlite3 major loses prebuilds for darwin-arm64, linux-x64 or win32-x64, or if `npx agentcap` install failures trace to node-gyp.

## D13 — DB path resolves upward to the project root, and refuses if there is none
`dbPath()` walks parents until it finds `.agentcap/`, like git finds `.git`, and throws `NoProjectError` at the filesystem root. Reason: `agentcap task kill` from a subdirectory previously opened a fresh empty DB in that subdirectory and reported success against nothing — the same failure as an in-memory status map. `init` still creates `.agentcap/` where it is run unless a parent already has one.

## D14 — loopback is asserted on the bound socket, not only in config
`listen()` calls `server.address()` and throws unless the address is `127.0.0.1` after the port is bound. Config-load validation only checks a string; this checks what the kernel did, so a future refactor cannot silently widen the bind.

## D15 — `/health` returns only `{ok, service}`
No provider map, no pricing, no resolved config. Keys are env-referenced already, but health is the one endpoint a browser or a curious process hits casually, so it stays constant-shape and leaks nothing.

## D7 amended — status is read from the database, never from memory
Forced by D7/D8 themselves: `task kill` flips status from a separate process, so an in-memory map in the proxy would never see it and the kill switch would be decorative. The proxy reads `SELECT status FROM tasks WHERE id=?` on a prepared statement; WAL makes it a sub-10µs read. Cost is not the argument, correctness is.
Throttled anyway (D16) so the query rate is bounded.
DoD amended: "kill stops within one chunk" is aspirational. The binding claim is **bounded ≤250ms, asserted by test**.

## D16 — kill/cap polling is throttled to every 4 chunks or 250ms, whichever is first
Unthrottled per-chunk reads are wasteful on a fast stream; throttling bounds the query rate and still puts the worst-case kill latency under a quarter second. The counter resets per request, so a slow upstream checks on every chunk anyway.

## D8 amended — termination order is fixed and the socket close is always clean
Strict per-chunk order: parse → accumulate usage → check caps → if breached, deliver this chunk, then close. Checking before accumulating is one chunk late on every count, forever.
Never change the HTTP status mid-stream — headers are gone. Instead a terminal frame: `data: [DONE]` on the OpenAI shape, `event: error` with the breach JSON on the Anthropic shape. `http_status` is recorded as 200 and the request status as `stuck` or `killed`.
No synthetic assistant message: a truncated stream is honest, a fabricated one corrupts the client's context and the client cannot tell.
The breach event is written before the socket closes, or the record is lost on a fast disconnect.

## D17 — tasks are addressed by request header, not by URL shape
`x-agentcap-task` and `x-agentcap-agent` headers. The proxy has to stay path-transparent (an agent points its own base URL at it and appends whatever path it likes), so the task cannot live in the path.

## D18 — upstream failure classes are distinguished, never collapsed into `killed`
Client abort → `client_gone`. Upstream error status, upstream socket error, or upstream close with no `[DONE]` → `upstream_error`. Cap or kill → `stuck`/`killed`. Collapsing them makes a flaky provider look like the budget system working.

## D19 — a cap key set to 0 or null means unlimited
Caps arrive from SQLite as `null` when unset, but `0` can be stored by a caller. `0 != null` is true in JS, so a naive null check would breach every request on frame one. `isSet()` in verdict.ts is the single predicate and requires `> 0`; both 0 and null are documented as unlimited so neither reads as a bug later.

## D20 — a missing task header is tracked as `unassigned`, not dropped
A request with no `x-agentcap-task` is proxied, logged with `task_id NULL` and `agent = 'unassigned'`, and gets no caps. Refusing it would break drop-in adoption; hiding it makes the dashboard look emptier than reality. Silent is worse than visible.

## D21 — accounting is task-scoped shared state, and usage only ever moves it forward
Replaces the per-request accumulator. A registry keyed by task id seeds from the DB exactly once per process (`counterFor`, guarded by entry presence) and is shared by every in-flight request on that task, so two concurrent requests cannot each burn a full budget before either notices.
The request keeps two independent floors — a monotone tokenizer estimate and the last authoritative usage number — and the task total only ever takes `max(0, newRequestTotal - previousReported)`. A cumulative usage frame replaces the request total and therefore cannot reset the task; a per-chunk-delta provider moves the total by one step per frame and cannot double count. Both shapes use the same arithmetic.
The registry entry is dropped on breach, so the next request re-seeds from the DB and the map cannot leak.
`max_seconds` is measured from `tasks.created_at`, not from request start.

## D22 — step and dead-task checks happen at admission, before the upstream call
`admit()` runs before the request row exists and refuses with the same 429 body: a `killed` task, a `stuck` task, and a task where `taskSteps + 1 > max_steps`. Previously a stuck task kept burning a request's worth of provider tokens before its own stream breached, and an over-limit step still reached the provider. A refused request writes no `requests` row, so it is not a step.

## D23 — stream shape comes from the path, with a per-provider override
`/messages` (and `/v1/messages*`) is the Anthropic shape, everything else OpenAI. A host check on `anthropic.com` broke for Anthropic-compatible proxies on other domains. `providers[].shape` overrides when a path cannot express it.

## D24 — `x-agentcap-*` headers are stripped before forwarding
`isLocalHeader()` filters them in `forwardHeaders`, and other client headers now pass through (minus host, content-length, connection). Most providers ignore unknown headers; some 400 on them.

## D25 — `sse.ts` split into framing, usage, accounting and verdict
Framing (`sse.ts`, 106 lines), boundary extraction (`usage.ts`), task counter and accountant (`accounting.ts`), caps and terminal frames (`verdict.ts`). The handover named `sse.ts` as the critical file; splitting keeps each part under 260 lines and testable alone.

## D26 — the request total is estimate-or-usage, never the max of both
Usage is the truth and the estimate is only a stand-in until the first usage frame. Taking the max looked safer but capped a stream at the tokenizer's guess even after real usage arrived, which over-counts prompts and breaches early on every OpenAI-style stream. Once any usage lands it wins outright.

### D26 consequences the next reader must know
A usage frame **lower** than the current estimate is not refunded on the task total: the task counter is monotone and the clamp eats the difference. Conservative by design — the task total can sit above the true spend until the next seed, never below it.
The estimate is floor-only and it is a **foreign tokenizer**: js-tiktoken is an OpenAI tokenizer applied to Anthropic streams too, so before the first usage frame the number can run 10-20% high. Nobody should treat a pre-usage figure as final. The README must say both of these in the counting section.

## D27 — a usage regression adds the new segment wholesale, it does not clamp
A decrease in a usage frame means the provider restarted its counter: a new segment, a retry, a multi-message stream. Clamping the delta to zero silently discards the segment and undercounts, which is the dangerous direction for a budget tool — the cap then fires late. So `delta = next >= prev ? next - prev : next`, which can overcount on a spurious dip: the safe side. A `usage_regressed` event is logged with `{previous, next}` so the behaviour is visible when a provider does it.

## D28 — usage merges field-wise, never whole-object
A frame carrying only `completion_tokens` must not zero `prompt_tokens` back to the estimate. Both fields are optional in the schema and each is only overwritten by a frame that actually carries it. `estimated` stays true until both fields have been seen.
Usage that arrives **after** the terminal frame (a trailer) still applies, and usage in a response header (`x-usage-prompt-tokens` / `x-usage-completion-tokens`) applies as authoritative usage before the first chunk. Parse order never assumes usage precedes the close.

## D29 — pricing is held per segment, and an unpriced model is priced at the ceiling
A model can change mid-stream (fallback routing, a proxy in front of a proxy), so one price applied to cumulative tokens is wrong on both sides of the switch. Each request holds `{model, priceIn, priceOut, prevTokens}`; a model change closes the segment, recomputes the price, and prices each segment separately. Tokens already burned are treated as paid at the new price so the switch itself adds no cost.
A model missing from the pricing table is **never** priced at zero — zero is an unbounded budget. It is priced at the highest known price (`ceilingPrice()`), and an `unpriced_model` event is logged. With an empty pricing table there is no ceiling and cost stays 0; that is a config problem the `unpriced_model` events make visible.

## D30 — `#sync` is fully synchronous, and the counter is released only when idle
The event loop is what makes a shared counter safe without a lock, so nothing in the accounting path awaits; one await mid-arithmetic would let two frames interleave.
Registry eviction used to fire on breach, which let in-flight siblings re-seed from the DB — whose sum only holds committed rows — and keep streaming past the cap. Now each request `enter()`s on admission and `leave()`s on settle (once, guarded), and `release()` evicts only when `activeRequests` is 0. A sibling that was already streaming sees the shared total and breaches on its next frame.

## D31 — admission is the only writer of the step count
Admission computes `used + 1` and passes it into the counter, which never re-reads or increments. Two writers would double count. Strict reading confirmed: `max_steps: 1` permits exactly one request, because cost is incurred per request and the ceiling is denominated in the same unit.

## D32 — one proxy per project, enforced with a pid lock
A second `agentcap start` on the same DB would half-enforce every cap, because each process holds its own in-memory counter. `.agentcap/lock` holds the pid; `start` refuses if the pid is alive and takes over if it is not, so a crash does not wedge the project. The lock is removed on exit. Multi-process remains unsupported in v0.1 — this converts a silent bug into a message.

## D33 — segment state is an object, and the invariant is structural
The invariant is: **`segment.prev` is a request-local total, never a task total.** Before this it held only by the type, and the type does not know where the number came from.
Segment state now lives in one object (`segments.ts`) constructed once per request and held in the live map by request id, passed into `#sync` by reference. `#sync` therefore has no access to anything task-scoped except `counter.add()`, so the signature cannot drift into comparing against a task number. A restart replaces the object (`restartSegment`, `base: 0`) instead of mutating a field someone can forget.
Three dev-only assertions in `#sync` enforce it at runtime: `activeRequests > 0` (a sync after settle is a bug), segment identity matches the map entry for that request id, and `seg.prev <= counter.tokens` (catches a task-scoped leak the moment it is introduced). They throw only outside production.
The pinning test — two requests on one task, interleaved frames, a restart in each, asserting the task total equals the sum of per-request maxima — fails the day anyone shares one accumulator, which is worth more than the assertions.

## D34 — the ceiling price is frozen at admission
Resolved once per request, not per frame. A live lookup would let two concurrent requests price the same unknown model differently in the log, which makes the log unauditable. A config change still applies to the next request, so the behaviour wanted is kept without the inconsistency.

## D35 — header usage is opt-in per provider
`x-usage-*` is not a namespaced header; any proxy in the path can set it for unrelated reasons. A provider declares it: `headerUsage: { prompt: "<header>", completion: "<header>" }`. Absent means the header path never runs. An undeclared header is ignored, asserted by test.

## D36 — `pricing.ts` and `segments.ts` split out of `accounting.ts`
Pricing resolution and segment arithmetic are pure and independently testable; keeping them in the accountant pushed it toward 400 lines with one feature left to add. `accounting.ts` keeps the accountant class.

## D37 — the counter registry lives in `counter.ts`
The dashboard reads live counters for the feed, which is the pressure that would have pushed `accounting.ts` past 400. The registry (map, seed-once, evict-at-zero, `peek`) is now its own module and the accountant imports `TaskCounter` as a type only. Split made before any UI code was written.

## D38 — invariant assertions default on, `--no-assert` opts out
`NODE_ENV` was the wrong axis: a tool run from `npx` usually has it unset, so checks were on by accident for most users and off for exactly the people who set it. Three integer comparisons per frame is nothing against network latency. `configureAsserts(false)` via `agentcap start --no-assert` is the escape hatch.

## D39 — header usage names are validated at load, unmatched headers warn once
`^[a-z0-9-]+$`, because Node lowercases response header keys and a mixed-case declaration would silently never match — a loud load error beats a silent zero. A declared header that never appears is still ambiguous (typo, or a provider that stopped sending it), so the first request to a provider with a missing declared header writes one `header_usage_unmatched` event with the missing names. Once per provider, not once per request. Accounting stays safe either way: the estimate remains in place.

## D40 — a hardcoded fallback ceiling, so an empty pricing table still caps
`ceilingPrice({})` used to return null, which made cost 0, which meant `max_usd` could never fire — an unpriced-everything install was effectively uncapped. `FALLBACK_CEILING` (15/75 per Mtok) is returned when the table has no non-zero entry. Over-pricing an unknown model is the safe direction; free is not.

## D41 — dashboard reads rowid, not timestamp, as its SSE cursor
Two requests in the same millisecond were skipped by a `ts > cursor` comparison, which is a lost feed row. `rowid` is monotonic in insert order and is what the feed displays anyway. The client keeps a 500-row ring buffer; the server ticks at 250ms and only writes when something changed.

## D42 — `untracked` is a pseudo-row in the tasks table, always rendered
Untracked traffic has no task row, and a bucket that only appears when non-empty is easy to miss. It is always present, marked `uncapped`, and sorted into the table by burn like any other row. Kill is absent for it because there is nothing to kill.

## D43 — `seq INTEGER PRIMARY KEY AUTOINCREMENT` replaces rowid as the feed cursor
Plain rowid is reused once the highest row is deleted, so a `rowid > cursor` comparison silently skips rows as soon as anything prunes. `seq` is a real AUTOINCREMENT column with the high-water mark kept in `sqlite_sequence`. Migration 002 recreates the table (SQLite cannot add one in place); migrations run with `foreign_keys = OFF` for the duration and `foreign_key_check` afterwards, because dropping a parent table is rejected while children still reference it.

## D44 — task table renders the top 100 by burn, sorts at most every 2s, freezes on hover/focus
At 50 tasks and a 250ms tick the table reordered faster than it could be read. Rows are capped at 100 with a `showing N of M by burn` line; ordering re-sorts at most every 2s; and ordering stops entirely while the pointer is over the table or a kill button has focus, otherwise the button moves out from under the cursor mid-click. Contents still merge on the tick that carries them — only order is throttled.

## D45 — one broadcast timer for every open dashboard
One interval per SSE connection meant two tabs doubled the query rate. A single shared timer serves all clients and is cleared when the last one disconnects; each client keeps its own cursor. Shared work (task table, untracked bucket) is computed once per tick.

## D46 — OTel is OTLP/HTTP JSON only, spans only
`application/json` or 415. No protobuf, no gRPC, no collector. Body cap 1 MB with 413. A span with no `gen_ai.request.model` is not an LLM call and is dropped; the remaining attributes are ignored rather than rejected, since exporters send far more than the mapped set and a strict schema would break on every SDK bump.

## D47 — span usage applies whole, through the same counter, and late usage is kept
A span is complete on arrival, so its usage is authoritative and whole rather than a delta — `applyUsage` is exactly that path. It goes through the same task counter as proxied traffic, so a task cannot escape a cap by reporting over OTel. If the cap already fired before the span landed, the spend is applied anyway and written as a `late_usage` event instead of a second breach. Latency comes from the span's own start/end nanos, never ingest wall clock, and the row is backdated to the span start so the feed orders it where it happened. A span naming an unknown task is recorded as `untracked`, not dropped.

## D48 — `source` column, `proxy` by default
The feed has to distinguish proxied traffic from reported traffic; they are not the same claim. The column defaults to `proxy`; OTel ingest writes `otel`.

## D49 — the docs capture resolves `CHROME_PATH` first, then platform paths
Headless `--screenshot` never fires on a page holding an open EventSource, so the capture drives Chrome over CDP instead. That made the hardcoded macOS bundle path a CI blocker: `CHROME_PATH` wins, then macOS, Linux and Windows standard locations, and the failure names `CHROME_PATH`.

## D50 — migration order: pragma outside the transaction, BEGIN IMMEDIATE, throw on foreign_key_check
`PRAGMA foreign_keys` is per-connection and is silently ignored inside a transaction, so setting it after `BEGIN` looks right and does nothing: the DROP of a referenced parent is rejected, and only on a DB that actually has rows. The runner now reads the current value, sets OFF outside any transaction, runs the migration in `BEGIN IMMEDIATE` (deferred can deadlock with the proxy's write lock), `COMMIT`s, throws on any `foreign_key_check` row (it reports, it does not abort), and restores the value the caller had rather than hardcoding ON. Migration 002 keeps `id TEXT UNIQUE` because `events.request_id` references it; dropping the column would leave that FK target dangling. Tests seed events rows, run 002 twice, and kill it mid-transaction to prove the rollback is clean.

## D51 — `tasks.breach_reason` is separate from the verdict, first write wins
`reason` was answering two questions at once. `status` says a task is dead; `breach_reason` says which cap fired, or that a human killed it, and is set once when the task is first marked dead (`markDead`, `COALESCE(breach_reason, ?)`) so a later verdict cannot rewrite it. Consequence: a task killed on `max_seconds` keeps saying `max_seconds` even after more usage arrives, and admission refuses with the recorded reason instead of guessing `max_tokens` for every stuck task. Migration 003 adds the column and backfills it from the earliest terminal event per task.

## D52 — `late_usage` describes the lateness, not the death
The event no longer overloads `reason`. Payload is `{reason, tokens, source, taskStatusAtArrival, currentVerdict, arrivedAfterMs, wouldExceed, capCrossed, alreadyOver}`: `reason` is why the task died, and the rest answers whether the cap was accurate. `wouldExceed` and `capCrossed` run the cap comparison alone (`breachedCaps()` in verdict.ts, since `evaluate` short-circuits to the death reason for a dead task) against the totals *before* this span. The dashboard shows the task's `breach_reason` in the status column and a `+N late` marker beside the token total, and the feed marks the row `late`.

## D53 — attribution is the cap these tokens crossed, not the first cap breached
`exceeds()` returned the first breached cap in priority order, which is backwards for the case study: a task already stuck on `max_tokens` whose late tokens finally break `max_usd` reported `max_tokens` again, so the one interesting event in the run read as a repeat. `breachedCaps()` now returns the whole set; ingest diffs it against the set already breached before the span and reports the new member as `capCrossed` (`null` when nothing new crosses), with the pre-existing set in `alreadyOver`. `exceeds()` stays as a thin `[0]` wrapper for callers that only need "is anything over". The measurement script sets a second `max_usd` cap for exactly this reason, and the run shows span 2 reporting `capCrossed: max_usd`.

## D54 — a missing span end time is `null`, not `0`
`arrivedAfterMs: 0` and "the exporter sent no `endTimeUnixNano`" were the same value and different facts. It is `number | null`, the dashboard renders `late ?` for null, and an `otel_missing_end_time` event is logged once per exporter — once, because a null in every payload is easy to read as "instant" and a per-span warning is noise.

## D55 — a manual kill goes through `killTask`, not a raw UPDATE
`task kill` and the dashboard kill both call `killTask()`, which sets `status = 'killed'` unconditionally (killing an already-stuck task must still move it) but `COALESCE`s `breach_reason`, so a human stopping a token breach does not relabel it `killed`. The dashboard route had its own copy of the UPDATE; it now re-exports the store function rather than keeping a second implementation that can drift.

## D56 — `js-tiktoken` is external to the bundle
It is 5.6 MB of inlined rank tables, and bundling it put `dist/cli.js` at 5.8 MB and the tarball at 2.6 MB even after the GIF was excluded. Externalising it (it is a normal runtime dependency, npm resolves it) takes the bundle to 197 KB and the tarball to 46.6 KB across 10 files. `better-sqlite3` stays external for the same class of reason — native, unbundleable.

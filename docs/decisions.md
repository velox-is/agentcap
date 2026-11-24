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
Handover says in-flight requests finish their current chunk then close. The CLI flips status to `killed` at once; the proxy (milestone 4) reads that status to decide the close. No in-memory task registry yet.

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
`listen()` now calls `server.address()` and throws unless the address is `127.0.0.1` after the port is bound. Config-load validation only checks a string; this checks what the kernel did, so a future refactor cannot silently widen the bind.

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
`x-agentcap-task` and `x-agentcap-agent` headers. The proxy has to stay path-transparent (an agent points its own base URL at it and appends whatever path it likes), so the task cannot live in the path. A request with no task header is logged with `task_id NULL` and gets no caps — untracked, not refused.

## D18 — upstream failure classes are distinguished, never collapsed into `killed`
Client abort → `client_gone`. Upstream error status, upstream socket error, or upstream close with no `[DONE]` → `upstream_error`. Cap or kill → `stuck`/`killed`. Collapsing them makes a flaky provider look like the budget system working.

## D19 — no cap key set to 0 means unlimited
Caps arrive from SQLite as `null` when unset, but `0` can be stored by a caller. `0 != null` is true in JS, so a naive null check would breach every request on frame one. The verdict requires `> 0`.

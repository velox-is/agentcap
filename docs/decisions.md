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

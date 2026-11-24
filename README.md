# agentcap

Local-first observability and hard budget control for AI agents. Point any agent's base URL at the proxy and it is instrumented with no code change.

![dashboard](https://raw.githubusercontent.com/veloxis/agentcap/main/docs/demo.gif)

## What it does

agentcap runs a local proxy on `127.0.0.1:4100`. Any tool that accepts a custom base URL — Hermes, OpenCode, Claude Code, n8n, a raw SDK — points at it instead of the provider. Every request is counted, priced and checked against the task's caps. When a cap is breached the stream is closed and the task is marked `stuck`.

Nothing leaves the machine. No account, no cloud, no telemetry.

## Quickstart

```sh
npx agentcap init      # writes agentcap.config.json + an example, creates .agentcap/
# edit agentcap.config.json: add a provider, its env var name, and its models
export OPENAI_API_KEY=sk-...
npx agentcap start     # proxy :4100, otel :4101, dashboard :4102
```

Then point your agent at the proxy and give it a task:

```sh
TASK=$(npx agentcap task new --name my-run --max-tokens 200000 --max-usd 2)
export OPENAI_BASE_URL=http://127.0.0.1:4100/v1
export OPENAI_AGENT_TASK=$TASK     # see "Attribution" below
```

Open <http://127.0.0.1:4102> for the live dashboard.

Why the numbers here are trustworthy, and where a cap legitimately overshoots: [docs/case-study.md](docs/case-study.md).

## Attribution

The task is passed in a header, because the path has to stay transparent:

| header | meaning |
| --- | --- |
| `x-agentcap-task` | task id. Missing means the request is counted as `untracked` and is **uncapped**. |
| `x-agentcap-agent` | label for the feed. Missing means `unassigned`. |

Anything else is forwarded upstream untouched; `x-agentcap-*` is stripped.

## Caps

Per task: `--max-tokens`, `--max-steps`, `--max-usd`, `--max-seconds`. `0` or absent means unlimited. `--max-steps 1` permits exactly one request.

A breach returns `429` at admission, or a terminal frame mid-stream:

```json
{"error":"budget_exceeded","task":"<id>","reason":"max_tokens"}
```

Kill a task from the dashboard, or `npx agentcap task kill <id>`. In-flight requests are closed after their current chunk, bounded at 250 ms.

## Numbers

Usage comes from the provider. When a provider omits it, agentcap falls back to a local tokenizer and marks the row `estimated` — the dashboard renders those with `~` and shows the estimated share of the task. The fallback tokenizer is an OpenAI tokenizer applied to every provider, so it runs 10-20% high on Anthropic. Do not read an estimated number as final.

A model with no `pricing` entry is priced at the highest rate in the table and flagged `!` in the dashboard rather than shown as free. An empty pricing table falls back to a fixed ceiling, so the USD cap still fires.

## Config

```json
{
  "bind": "127.0.0.1",
  "ports": { "proxy": 4100, "otel": 4101, "dashboard": 4102 },
  "providers": {
    "openai": { "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY", "models": ["gpt-4o-mini"] }
  },
  "pricing": { "gpt-4o-mini": { "in": 0.15, "out": 0.6 } }
}
```

Keys are env var names only, never in the file. `shape` (`openai` | `anthropic`) overrides path-based stream detection; `headerUsage` opts a provider into usage headers it actually sends. Binding is loopback-only and enforced after `listen`.

## Requirements

Node 22+. One process per project (enforced by a pid lock in `.agentcap/`). SQLite via better-sqlite3.

## Development

```sh
npm ci
npm test          # vitest
npm run typecheck
npm run build
bash scripts/smoke.sh
```

Invariant assertions are on by default; `agentcap start --no-assert` turns them off.

MIT.

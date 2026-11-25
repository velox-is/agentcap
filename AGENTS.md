# AGENT RULES

Rules for any agent working in this repo. They exist because the failure mode is
not bad plans, it is re-planning: repeating a broken shape instead of reading the
error.

## Wire format

Reply with exactly one JSON object. No markdown fences. No prose outside it.

```
{"content":"one line of what this step does","status":"continue","tool_calls":[{"name":"terminal","arguments":{"command":"ls"}}]}
```

`status` is `continue` (more work, `tool_calls` non-empty), `done` (final answer,
`tool_calls: []`), or `ask` (needs the user, `tool_calls: []`). Never emit a
tool call inside the reasoning channel. Never emit a bare `name({...})` call.

## Session shape

- One blocker or one launch task per session. If the session has four, do the
  first and stop.
- Five bullets of reasoning, maximum, before the first tool call.
- No re-planning mid-session unless a tool result contradicts the plan.

## Tool errors

Two attempts per tool call. On the second failure, print the error verbatim plus
the exact arguments that were sent, then stop. Never retry a third time.

## Identity, in this repo only

- Commit as `Veloxis <360688350+velox-is@users.noreply.github.com>`. Repo-local
  config, never global.
- Remote is `https://github.com/velox-is/agentcap.git`. Run
  `scripts/check-identity.sh` before every push; the tracked pre-push hook runs
  it too.
- Never `gh auth switch` without re-checking `git remote get-url origin`
  afterwards. The hook guards this repo and nothing else, so a stray push from
the wrong account is the one way to undo the identity work.
- `veloxis.dev` is unregistered and must appear nowhere. `J0SEPH-K` is the
  retired handle.

## Freeze

No features, no refactors, no new dependencies except security. Bugfixes only.
Anything else goes to `docs/backlog.md`.

## Before a commit

`npx tsc --noEmit` and `npx vitest run` both clean. Conventional commits. A docs
commit follows the code commit it describes, never precedes it.

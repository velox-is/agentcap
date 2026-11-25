# Backlog

Frozen during launch. Bugfixes only until the launch metrics are in.

- Header-based attribution means a tool that cannot set headers runs uncapped.
  A base-URL query parameter (`?agentcap_task=`) would cover those, at the cost
  of rewriting the client's path.
- `exceeds()` is now a `[0]` wrapper over `breachedCaps()` with one caller left.
  Delete it or keep it deliberately.
- The fallback tokenizer is an OpenAI encoding applied to every provider, so
  estimated counts run high on Anthropic. A per-provider tokenizer map would
  fix it and is not worth the dependency yet.
- `docs/dashboard.png` is stale relative to the late-marker change and ships in
  the repo but not the package. Regenerate or drop it.
- No `agentcap task list`, so the only way to see an id is the dashboard or the
  moment of creation.

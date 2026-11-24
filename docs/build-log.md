# Build log

One entry per working day during the warm-up. Newest last. Facts only: what
changed, what broke, what was measured. This is the evidence the repo is alive
while the posting account is still too young to link it.

## 2026-11-24

- Cap accuracy measured for the first time and written up in
  `docs/case-study.md`: 210 tokens at breach on a 100-token cap, 1,120 late
  tokens across 3 spans, `capCrossed` set correctly on the span that broke
  `max_usd` and on nothing else.
- Fixed: `exceeds()` returned the first cap in priority order, so a task already
  dead on `max_tokens` reported `max_tokens` for late tokens that broke
`max_usd`. Now `breachedCaps()` returns the set and ingest diffs it (D53).
- Fixed: `arrivedAfterMs` conflated "0 ms" with "exporter sent no end
  timestamp". Now `null`, rendered `late ?`, warned once per exporter (D54).
- Fixed: `task kill` and the dashboard kill were two copies of the same UPDATE;
  now one `killTask()` with `COALESCE(breach_reason)` so a manual kill cannot
  relabel a token breach as `killed` (D55).
- Bundle: `js-tiktoken` externalised, 5.8 MB → 197 KB, tarball 2.6 MB → 47 KB
  across 10 files, GIF excluded and referenced absolutely (D56).
- 152 tests, tsc clean, pack/install verified on Node 22.23.5 and 26.13.1.
- Repo public, topics set, v0.1.0 released.

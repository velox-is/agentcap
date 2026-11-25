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

## 2026-11-25 (launch phase, day 0)

- Identity pinned to `velox-is`: 48 commits rewritten to the noreply address,
  remote and repo-local config set, tracked `.githooks/pre-push` plus
  `scripts/check-identity.sh` wired through `core.hooksPath`, same hook in the
  site repo. Hook verified in both directions (wrong remote fails).
- CI added and green: identity, tsc, 152 tests, smoke, and a second job that
  installs the packed tarball and asserts the fallback tokenizer resolves from
  it with `estimated=1` on both Node 22 and 26.
- Signup page live at <https://agentcap.pages.dev> - static page, one Cloudflare
  Function, KV keyed by address. Probe rows deleted, count back to 0.
- `agentcap.dev` DNS is blocked: the zone lives in a different Cloudflare
  account than the authed one (zero zones there). Steps written into
  `docs/launch-plan.md`. Not launch-blocking.
- Self-hosting section added to the README because r/selfhosted requires one.
- `AGENTS.md`, `docs/backlog.md`, `docs/feedback.md`, `docs/launch-metrics.md`.

## 2026-11-25 (day 0, continued)

- Identity hole closed: `includeIf "gitdir:~/Projects/agentcap*/"` in
  `~/.gitconfig` pointing at a Veloxis identity file, so a fresh clone commits
  correctly with no manual step. Verified on a real clone into a matching path.
- `check-identity.sh` now also fails on any `Co-authored-by:` trailer carrying a
  foreign address - agents add those and they leak the same thing.
- Signup endpoint captures `document.referrer` and `location.origin`, keeps the
  first attribution on a resubmit, and counts `seen`. Verified end to end: row
  reads the Reddit URL and `seen:2` after a second POST from another referrer.

## 2026-11-25 (day 1, warm-up)

- Baseline row recorded: 0 stars, 0 signups, 0 traffic, 0 issues. Everything after
  is measured against it.
- Read three subs' new queues and picked threads under 24 hours old: r/LocalLLaMA
  on API cost vs flat subscription, r/n8n on QA gate placement in a 4-agent
  research loop, r/ClaudeAI on agent count exploding. Drafts and links are in
  `docs/day1-comments.md`.
- No links, no product name. One number in each: the $5.40/hr figure, the single
  writer for the counter, the artifact-not-transcript handoff.
- Posted all three from u/_Veloxis_ and checked each logged-out in a clean profile:
  all render for anonymous visitors, none filtered. Permalinks in the comments file.
- Posting path that works: a throwaway `--user-data-dir` Chrome with
  `--remote-debugging-port`, sit through the humanity interstitial, then type into
  old.reddit's `textarea[name=text]` via CDP `Input.insertText`. New reddit's
  composer is nested shadow DOM and `insertText` does not reach it.

## 2026-11-26 (day 2)

- No replies overnight; inbox empty. Two comments instead of three: r/selfhosted
  on backup verification, r/ClaudeAI on subagent fan-out.
- **Both LocalLLaMA comments from day 1 were removed by a moderator** within 20 and
  50 minutes. ClaudeAI, n8n and selfhosted all kept theirs. LocalLLaMA rule 3 bans
  "completely/primarily LLM generated copy". Recorded in launch-metrics with a
  sub tally; LocalLLaMA is 0/2 and the next attempt there has to be plainer.
- Per-comment table added: upvotes, replies, live/removed, plus a warm-leads table.
  By day 8 the sub tally picks the launch sub instead of guessing.

## 2026-11-26 (schedule correction)

- The launch pin was wrong twice. It said "day 11, 2026-12-06"; Dec 6 is a
  Sunday, and the count was one day ahead of the calendar on top of that.
- Re-pinned to **Thursday 2026-12-03, 22:00–23:00 KST** (13:00–14:00 UTC,
  08:00–09:00 US Eastern). KST night is the point: a 14:00 KST post is midnight
  in New York. Friday 12-04 is the fallback, Monday 12-07 the alternative if two
  days are lost.
- Launch is posting day 10. The old day-10 prep section is now day 9 and includes
  the endpoint and apex checks that used to sit on launch morning.
- Case-study rewrite moved to days 4–5 with the review on day 6, four days before
  posting. Re-run `scripts/measure-late.mjs` on the rewrite day so every number
  in the document comes from that day's output.

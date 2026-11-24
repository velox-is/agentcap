# Launch plan — 10 days of warm-up, then one post

The repo is done. That is not the same as the account being able to post. A new
Reddit/HN identity gets filtered on its first link no matter how good the link
is, so the warm-up is not optional and it is not a formality.

Rules that apply the whole time:

- **No links in the first week.** Comments carry the argument, not the URL. A
  first-day account posting a GitHub link reads as promotion and gets removed.
- **Comment where the pain already is**, not where the product is. Threads about
  runaway token spend, agents in a loop, an API bill that surprised someone.
- **Never claim what the repo cannot show.** If a number is quoted, it is the one
  in `docs/case-study.md`, from `scripts/measure-late.mjs`, or it is not quoted.
- **One post per day maximum** after day 7, and only if there is something new.

## Days 1–3 — presence

- [ ] Account created, profile filled: real handle, one line, no pitch.
- [ ] Read the pinned rules of each target sub. Rules differ and the differences
      are the whole game.
- [ ] 3–5 comments/day on threads where someone describes the problem. Answer the
      problem. No mention of agentcap.
- [ ] Day 3: check which comments got replies. That is the vocabulary to reuse.

## Days 4–6 — credibility

- [ ] Post one comment with a real technique and no product (e.g. the polling
      window tradeoff, or why a per-request accumulator overshoots).
- [ ] Answer every reply within a few hours. Late replies on a young account look
      like a bot.
- [ ] Day 6: a comment that mentions agentcap by name, still without a link.

## Days 7–9 — link allowed

- [ ] Day 7: first comment with the link, in a thread that asked for a tool.
- [ ] Day 8: check referrer-less traffic in `gh api repos/J0SEPH-K/agentcap/traffic/views`.
- [ ] Day 9: draft the launch post. Title states the problem, not the product.

## Day 10 — launch

- [ ] Post. Body opens with the failure mode the case study is about, links the
      case study, not the repo root.
- [ ] Sit in the thread for 4 hours. Every question answered with a number or a
      file path.
- [ ] Do not repost on a second sub the same day. Cross-posting same-day is the
      most common way a young account gets flagged.

## Targets

In rough order of tolerance for a tool link:

| Sub | Fit | Note |
| --- | --- | --- |
| r/ClaudeAI | high | accepts tool posts, hostile to hype |
| r/LocalLLaMA | medium | wants local-first, will ask why not an SDK |
| r/SideProject | medium | tolerates self-promo by design, low traffic |
| r/devops | low | needs an ops framing, not an agent framing |
| HN Show HN | low | needs the account to be a week old minimum |

## Blockers

- **Domain.** `agentcap.dev` is registered (2026-02-25, expires 2027-02-25,
  Cloudflare NS, no A record — parked). `agentcap.io` and `getagentcap.com` are
  taken. `agentcap.sh`, `agentcap.run`, `agentcap.tools` look free at Porkbun
  (31.20 / 4.12 / 9.78 USD first year, renewals 46.65 / 25.23 / 32.44). `.run` is
  cheap and renews badly; `.sh` fits a CLI tool but is 31 USD and was not
  confirmed free. No registrar credentials are on this machine.
- **Profile pin.** GitHub user pinned items are profile-level and have no public
  API mutation; it is a click on the profile page. Repo topics are set
  (`ai-agents`, `llm`, `observability`, `budget`, `proxy`, `sqlite`, `cli`,
  `typescript`).

## Build log

`docs/build-log.md` gets one dated entry per working day: what changed, what
broke, what was measured. It is the proof the repo is alive during the week the
account cannot post links yet.

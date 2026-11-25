# Launch plan — warm-up, then one post

The repo is done. That is not the same as the account being able to post. A new
Reddit/HN identity gets filtered on its first link no matter how good the link
is, so the warm-up is not optional and it is not a formality.

**Launch: Thursday 2026-12-03, 22:00–23:00 KST.** That is 13:00–14:00 UTC and
08:00–09:00 US Eastern — US morning, a real weekday for HN, clear of the weekend
decay. KST night is the correct hour precisely because it is US morning; a 14:00
KST post lands at midnight Eastern and is read by nobody.

**Fallback: Friday 2026-12-04, same hour**, if the case study is not reviewed or
the site is broken. **Alternative: Monday 2026-12-07**, better for HN, worse for
Reddit, only if two warm-up days are lost outright.

Day 1 was 2026-11-25, so launch is posting day 9. The old pin said "day 11 /
Dec 6" and was wrong twice — Dec 6 is a Sunday, and the count had one extra day.

Rules that apply the whole time:

- **No links in the first week.** Comments carry the argument, not the URL. A
  first-day account posting a GitHub link reads as promotion and gets removed.
- **Comment where the pain already is**, not where the product is. Threads about
  runaway token spend, agents in a loop, an API bill that surprised someone.
- **Never claim what the repo cannot show.** If a number is quoted, it is the one
  in `docs/case-study.md`, from `scripts/measure-late.mjs`, or it is not quoted.
- **Two or three comments a day, not a fixed three.** A constant three reads as a
  schedule. Vary length: one short and blunt, one longer and technical. Do not
  answer everything on the page.
- **One post per day maximum** after day 6, and only if there is something new.

## Schedule

| day | date | work |
| --- | --- | --- |
| 1 | Wed 11-25 | baseline row, three comments — done |
| 2 | Thu 11-26 | replies first, two comments — done, LocalLLaMA removals logged |
| 3 | Fri 11-27 | presence. Reply to anything overnight. Two comments. |
| 4 | Sat 11-28 | case-study rewrite, first pass |
| 5 | Sun 11-29 | case-study rewrite finished; two comments |
| 6 | Mon 11-30 | case-study review signed off; first comment naming agentcap, no link |
| 7 | Tue 12-01 | first comment with a link, in a thread that asked for a tool |
| 8 | Wed 12-02 | prep day, then stop posting |
| 9 | Thu 12-03 | launch, 22:00–23:00 KST |

The case study is done on day 5 and reviewed on day 6, four days before launch.
Rewriting it on launch morning is how a typo in the numbers ships.

## Days 1–3 — presence

- [ ] Account created, profile filled: real handle, one line, no pitch.
- [ ] Read the pinned rules of each target sub. Rules differ and the differences
      are the whole game. r/LocalLLaMA rule 3 bans LLM-generated copy outright.
- [ ] 2–3 comments/day on threads where someone describes the problem. Answer the
      problem. No mention of agentcap.
- [ ] Day 3: check which comments got replies. That is the vocabulary to reuse.

## Days 4–6 — the case study, then credibility

The case study is the artifact the launch post links. It has to read as a
measurement, not a pitch.

- [ ] Day 4: rewrite the opening. First sentence is the failure mode, not the
      product name. Drop the "the interesting part is not the kill" frame.
- [ ] Day 5: re-run `scripts/measure-late.mjs` and paste fresh output. Every
      number in the document must match a line the script printed today.
- [ ] Day 5: cut the two defensive passages — the "a reader who sees only cap 100
      spent 210 concludes the cap is decorative" paragraph is argued at twice the
      length it needs.
- [ ] Day 6: review pass. Every claim traceable to a script or a decision ID, or
      deleted. Then the first comment that names agentcap, still no link.
- [ ] Answer every reply within a few hours. Late replies on a young account look
      like a bot.

## Days 7–8 — link, then prep

- [ ] Day 7: first comment with the link, in a thread that asked for a tool.
- [ ] Day 8: check referrer-less traffic in `gh api repos/velox-is/agentcap/traffic/views`.
- [ ] Day 8: confirm the signup endpoint answers 200 with `ok:true` and that the KV
      count equals the metrics row.
- [ ] Day 8: final read of the launch post. Title states the problem, not the
      product. Read it aloud once.
- [ ] Day 8: confirm `agentcap.pages.dev` still serves and the apex still answers.

## Day 9 — launch (Thu 2026-12-03, 22:00–23:00 KST)

Do not post early. One sub, then Show HN the same day, then nothing.

- [ ] Post. Body opens with the failure mode the case study is about, links the
      case study, not the repo root.
- [ ] Sit in the thread for 4 hours. Every question answered with a number or a
      file path.
- [ ] Do not repost on a second sub the same day. Cross-posting same-day is the
      most common way a young account gets flagged.

## Targets

Written from each sub's own pinned rules, not scraped summaries:

| Sub | Fit | Rule that decides the post |
| --- | --- | --- |
| r/ClaudeAI | high | Loosest of the four about tools, and the only sub that has not removed a comment. Hostile to hype, fine with a screenshot and a short mechanism description. |
| r/LocalLLaMA | high value, low reliability | Rule 3 bans LLM-generated copy and removed both day-1 comments. Technical detail required and the repo link belongs in the body, but the prose has to be plainer than everywhere else. |
| r/n8n | medium | Short tool post tolerated, but it has to name a concrete workflow. Vague "works with everything" framing gets ignored. |
| r/selfhosted | medium | Rule 6 confines projects younger than three months to the New Project Megathread; rule 5 gives a Wednesday window for tools that are not self-hosted. A Thursday launch here needs the megathread or a self-hosted angle. Flair is mandatory and the post is removed without it. |
| r/SideProject | low | Tolerates self-promo by design, low traffic. Cheap cross-post, not a launch. |
| HN Show HN | low | Account must be a week old minimum. Title is fixed as `Show HN: agentcap – ...`. |

## Blockers

- **Domain — in someone else's Cloudflare account, and not launch-blocking.**
  `agentcap.dev` is registered through Cloudflare (2026-02-25, expires
  2027-02-25) and its NS are Cloudflare's, but the authed account has zero
  zones, so the DNS records cannot be written from here. Three clicks in the
  account that holds the zone:
  1. DNS → add a `CNAME` named `agentcap` pointing at `agentcap-site.pages.dev`,
     proxied (orange cloud).
  2. Workers & Pages → `agentcap` → Custom domains → attach `agentcap.dev`.
  3. Wait for the certificate, usually under a minute.

  Until then the site is live at <https://agentcap.pages.dev> and the warm-up
  proceeds there. Do not hold the schedule for DNS.
- **`agentcap.pages.dev` is the canonical URL in the meantime.** If the domain
  never lands, the README links pages.dev and nothing else changes.
- **Profile pin.** GitHub user pinned items are profile-level and have no public
  API mutation; it is a click on the profile page. Repo topics are set
  (`ai-agents`, `llm`, `observability`, `budget`, `proxy`, `sqlite`, `cli`,
  `typescript`).

## Build log

`docs/build-log.md` gets one dated entry per working day: what changed, what
broke, what was measured. It is the proof the repo is alive during the week the
account cannot post links yet.

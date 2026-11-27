# Launch plan — warm-up, then one post

The repo is done. That is not the same as the account being able to post. A new
identity gets filtered on its first link no matter how good the link is, so the
warm-up is not optional and it is not a formality.

**Launch: Thursday 2026-12-03, 22:00–23:00 KST.** That is 13:00–14:00 UTC and
08:00–09:00 US Eastern — US morning, a real weekday for HN, clear of the weekend
decay. KST night is the correct hour precisely because it is US morning; a 14:00
KST post lands at midnight Eastern and is read by nobody.

**Fallback: Friday 2026-12-04, same hour**, if the case study is not reviewed or
the site is broken. **Alternative: Monday 2026-12-07**, better for HN, only if two
warm-up days are lost outright.

Days 1 and 2 both ran on 2026-11-25 KST, so the day numbers sit one ahead of
the calendar and 12-03 is posting day 10: nine warm-up days, then the post.
The old pin said "day 11 / Dec 6" and was wrong twice — Dec 6 is a Sunday,
and the count carried one extra day on top of that.

**Reddit is out of the launch.** Three subs issued permanent bans on 2026-11-26
(r/selfhosted 17:14, r/n8n and r/ClaudeAI 17:53). Two of them quote the identical
line "Bots and bot-like accounts are not welcome" and both point at
`/r/BotBouncer`, so the cause is a bot classifier, not moderator judgement. Every
warm-up comment was removed before the bans landed.

HN was already primary and now stands alone. The Reddit appeal is still worth
sending — it costs one message and can only help — but **nothing on the calendar
depends on it**. Details and the ready-to-paste appeal text in
`docs/appeal-botbouncer.md`; evidence in `launch-metrics.md`.

HN is one shot and unforgiving. The smaller pool is the price of dropping Reddit,
so the quality of that single post matters more now, not less.

## Surfaces

| surface | role | why |
| --- | --- | --- |
| Hacker News | **the launch** | No gate to pass to post, but a new account's first comment lands `[dead]` and only the author sees it. Needs a week of history before it submits, and the launch-day check is logged-out, not author-view. |
| community.n8n.io | warm-up + credibility | Discourse forum, indexed, real humans asking real workflow questions. Answers stay findable, unlike chat. |
| Hermes/Nous Discord | warm pool | Not indexed, so no traffic, but the people there are the exact audience and they talk. Credibility only. |
| OpenCode Discord | warm pool | Same, and the tooling overlap is close. |
| n8n Discord | warm pool | Same. |
| r/test | one live comment | Only as the visible artifact for the appeal. Not a channel. |

## Rules that apply the whole time

- **No links in the first week.** Comments carry the argument, not the URL. A
  first-day account posting a GitHub link reads as promotion.
- **Write where the pain already is**, not where the product is. Threads about
  runaway token spend, agents in a loop, an API bill that surprised someone, a
  workflow firing when it should not.
- **De-LLM the prose, hard.** HN is more allergic to generated copy than Reddit
  was, not less — the guidelines say it flatly: "Don't post generated text or
  AI-edited text." Short sentences. One terminal paste where a paste helps. Start
  mid-thought instead of with a frame. No em dashes. No tricolons. Let the last
  sentence stop.
- **Never claim what the repo cannot show.** If a number is quoted, it is the one
  in `docs/case-study.md`, from `scripts/measure-late.mjs`, or it is not quoted.
- **One HN comment, one forum answer, one Discord answer per day.** Vary length:
  one short and blunt, one longer and technical. Do not answer everything on the
  page.
- **Nothing goes to HN before day 10.** A Show HN from a three-day-old account
  gets flagged and there is no second first impression.
- **Check every HN comment logged out, never in the author view.** Day 4 proved
  it: the first comment rendered fine while logged in, at 1 point, no marker, and
  was `[dead]` anonymously from the first minute. The author view is the trap that
  already burned a day on Reddit.
- **Answer every reply within a few hours.** Late replies on a young account read
  as a bot, which is the exact thing that already cost four subs.

## Schedule

| day | date | work |
| --- | --- | --- |
| 1 | Wed 11-25 | baseline row, three Reddit comments — done, all later removed |
| 2 | Wed 11-25 | replies first, two Reddit comments — done, same |
| 3 | Thu 11-26 | Reddit removed and three subs banned. HN account + first genuine comment. community.n8n.io registration. |
| 4 | Fri 11-27 | case-study rewrite, first pass. One HN comment, one forum answer, one Discord answer. |
| 5 | Sat 11-28 | case-study rewrite finished with fresh `measure-late` output. Same three surfaces. |
| 6 | Sun 11-29 | case-study review signed off. Two awesome-list PRs. README opening rewritten de-LLM. Same three surfaces. |
| 7 | Mon 11-30 | dev.to draft. Same three surfaces. |
| 8 | Tue 12-01 | PH assets if PH is happening. HN post final read. Same three surfaces. |
| 9 | Wed 12-02 | prep, then stop posting. |
| 10 | Thu 12-03 | launch, 22:00–23:00 KST |

The case study is done on day 5 and reviewed on day 6, four days before launch.
Rewriting it on launch morning is how a typo in the numbers ships.

## Day 3 (tonight) — the new accounts

- [x] HN account `veloxis` created, profile and about filled, email set. First
      comment posted 09:28 on an Ask HN about agents-per-ticket (50661374) — and it
      went `[dead]` inside a minute. Not deleted, not recoverable by editing; it
      needs vouches (>30 karma) or account age. The clock is running, the comment
      is not visible, and that is expected for now.
- [ ] HN is under a live Show HN throttle (`/showlim`, "temporarily restricting
      Show HNs because of a massive influx"). Still allowed for new accounts, but
      day 10 must assume the post can be dead on arrival.
- [x] community.n8n.io — registered as `veloxis`, activation email sent. Blocked:
      the mail goes to veloxis.co@gmail.com and neither headless profile has a
      Google session. Activate, then find a thread where an execution loops or
      fires when it should not and answer with the stop-condition pattern. Live
      OP, no links, no product name.
- [ ] Join the three Discords — Hermes/Nous, OpenCode, n8n. Lurk only tonight;
      one answer each over the following days.
- [ ] Send the BotBouncer appeal (`docs/appeal-botbouncer.md`). Costs nothing,
      nothing on the calendar depends on it.
- [ ] `!cqs` in r/test is optional now. It measures a classifier we no longer
      launch behind.

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
      deleted. Then two awesome-list PRs and the README opening rewritten de-LLM.
- [ ] Every day: one HN comment, one forum answer, one Discord answer.

## Days 7–9 — draft, assets, prep

- [ ] Day 7: dev.to draft. Same rules, same de-LLM treatment, no link.
- [ ] Day 8: PH assets if PH is happening, and the final read of the HN post.
      Check referrer-less traffic in `gh api repos/velox-is/agentcap/traffic/views`.
- [ ] Day 9: confirm the signup endpoint answers 200 with `ok:true` and that the KV
      count equals the metrics row.
- [ ] Day 9: final read of the launch post. Title states the problem, not the
      product. Read it aloud once.
- [ ] Day 9: confirm `agentcap.pages.dev` still serves and the apex still answers.
- [ ] Day 9: stop posting. Nothing on launch eve.

## Day 10 — launch (Thu 2026-12-03, 22:00–23:00 KST)

Do not post early and do not submit anything to HN before this hour.

- [ ] Show HN. Title is fixed as `Show HN: agentcap – ...`, body opens with the
      failure mode the case study is about, links the case study, not the repo
      root.
- [ ] **Immediately check it logged out** on `https://news.ycombinator.com/shownew`.
      Author view will show it either way. If it is `[dead]` or absent, that is the
      launch condition, not a reason to repost — a dead post recovers by vouching
      from other accounts (>30 karma) and by moderators reading vouched items.
      Do not delete and resubmit; that is banned.
- [ ] Put the case-study opening in the text field. Only post it as the first
      comment if the post does not appear at all.
- [ ] Sit in the thread for 4 hours. Every question answered with a number or a
      file path.
- [ ] Do not cross-post the same day. One surface, one post, all attention on it.
- [ ] If the BotBouncer appeal happened to land, the r/test comment is the only
      Reddit presence that matters. Do not open a new front on launch day.

## Targets

| target | fit | what decides it |
| --- | --- | --- |
| HN Show HN | **primary, the only launch surface** | No filter to clear. New-account comments and posts are visible from the first one, they just rank low. Account is a week old on 12-01, so the launch date clears the ring-detector minimum. Title is fixed as `Show HN: agentcap – ...`. One shot. |
| community.n8n.io | warm-up, high | Discourse, indexed, technical. Answers about loop and stop-condition patterns are exactly on topic. No gate. |
| Hermes/Nous Discord | warm pool, medium | Right audience, no indexing, credibility only. |
| OpenCode Discord | warm pool, medium | Tooling overlap is close. |
| n8n Discord | warm pool, medium | Same. |
| r/test | artifact only | One live comment is public and visible; it is the thing a BotBouncer reviewer can look at. Not a channel. |
| Reddit (all others) | out | Three permanent bans from a bot classifier. Appeal is optional upside, not a dependency. |

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

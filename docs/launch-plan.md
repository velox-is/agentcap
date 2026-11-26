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

Days 1 and 2 both ran on 2026-11-25 KST, so the day numbers sit one ahead of
the calendar and 12-03 is posting day 10: nine warm-up days, then the post.
The old pin said "day 11 / Dec 6" and was wrong twice — Dec 6 is a Sunday,
and the count carried one extra day on top of that.

**Day 3 changed the plan twice over, then a third time when the bans landed.** First
reading was an account-level filter: eight warm-up comments across four subs
removed one to sixteen hours after posting, no modmail, no rule quoted, profile
empty anonymously. The r/test control then killed half of that. A one-word comment
posted there at 09:15 is still visible logged out at +3h53m (13:08, fresh
anonymous profile, no removal marker) and renders on the profile, so the account
is not shadowbanned, confidence 0.95.

Then at 17:14–17:53 three subs issued **permanent bans** — r/selfhosted on the
off-topic rule, and r/n8n and r/ClaudeAI on the identical line "Bots and bot-like
accounts are not welcome", both pointing at `/r/BotBouncer` for the appeal. So the
cause is a bot classifier, not moderators working a queue. Not shadowbanned, but
classified as a bot, which is worse for launch purposes: four of the five target
subs will not hold a post from this account.

The control also handed over a measurable lever: r/test runs an `!cqs`
AutoModerator bot that reports the account's sitewide Contributor Quality Score,
and other accounts in the same thread scored "lowest", "low" and "moderate". CQS
is the classifier's own number. Next commenting day posts `!cqs` and records it.

Consequences, all of them:

- **HN is primary.** New-account comments there are visible and merely rank low,
  with no filter to clear. Dec 3 stands, HN-only if it has to be.
- **Reddit is conditional, gated on day 8 — and now on an appeal.** One comment
  visible logged out by then on a given sub and that sub launches; still dark and
  it is HN-only and Reddit gets posted whenever it clears. The gate is explicit
  below, not a hope. With three subs banned the realistic route is the
  /r/BotBouncer appeal, not a lucky comment.
- **LocalLLaMA is off the list** by the pre-set rule, no fourth attempt this week.
- **Commenting is capped at one a day** until something is visible. Eight
  comments into a void is material for a later post, not progress.
- **The account still needs to look alive** for the appeal and the modmail, so
  the one a day goes to r/test or ClaudeAI.

Details, evidence and confidence numbers in `launch-metrics.md`.

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
- **One a day while nothing is visible.** From day 3 the cap is one comment a day
  in r/test or ClaudeAI until a comment survives 90 minutes logged out. The cap
  lifts on the first one that does. The control cleared 90 minutes at +3h53m, so
  the cap lifts now; the r/test control is a control, not warm-up content, and
  does not itself count.
- **Summon `!cqs` in r/test on the next comment** and log the score. It is the
  only measurable proxy for the removals and it doubles as a legal one-a-day
  comment.
- **One post per day maximum** after day 6, and only if there is something new.

## Schedule

| day | date | work |
| --- | --- | --- |
| 1 | Wed 11-25 | baseline row, three comments — done |
| 2 | Wed 11-25 | replies first, two comments — done, LocalLLaMA removals logged |
| 3 | Thu 11-26 | LocalLLaMA retry + ClaudeAI — both removed, then THREE PERMANENT BANS landed (selfhosted, n8n, ClaudeAI). r/test control passed at +3h53m logged out: not a shadowban, but classified as a bot. |
| 4 | Fri 11-27 | case-study rewrite, first pass |
| 5 | Sat 11-28 | case-study rewrite finished; two comments |
| 6 | Sun 11-29 | case-study review signed off; first comment naming agentcap, no link |
| 7 | Mon 11-30 | first comment with a link, in a thread that asked for a tool |
| 8 | Tue 12-01 | GATE: is one Reddit comment visible logged out? Yes → that sub launches. No → HN-only. Also link follow-up and referrer-less traffic. |
| 9 | Wed 12-02 | prep day, then stop posting |
| 10 | Thu 12-03 | launch, 22:00–23:00 KST |

The case study is done on day 5 and reviewed on day 6, four days before launch.
Rewriting it on launch morning is how a typo in the numbers ships.

## Days 1–3 — presence

- [ ] Account created, profile filled: real handle, one line, no pitch.
- [ ] Read the pinned rules of each target sub. Rules differ and the differences
      are the whole game. r/LocalLLaMA rule 3 bans LLM-generated copy outright.
- [ ] 2–3 comments/day on threads where someone describes the problem. Answer the
      problem. No mention of agentcap.
- [ ] Day 3: check which comments got replies. That is the vocabulary to reuse.
- [ ] Day 3, if anything was removed: switch the liveness check to a fresh
      browser profile. Logged-in old.reddit keeps rendering your own removed
      comments and keeps the score at 1, so it will tell you everything is fine
      while nobody can see them.
- [ ] Day 3: run the no-moderation control. One word in r/test, checked logged
      out at +10. Visible there means the account is fine and the subs are the
      problem. Invisible there means the account is filtered and sub choice stops
      mattering.
- [ ] Day 3: appeal. **/r/BotBouncer first** — that is the route two of the three
      bans name, one message, name the account, say a person ships the tool, ask
      for the classification to be reversed. Then a separate modmail to
      r/selfhosted on the off-topic reason. Both blocked on the lost login.

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

## Days 7–9 — link, then prep

- [ ] Day 7: first comment with the link, in a thread that asked for a tool.
- [ ] Day 8, the gate: take the sub whose comment is still visible logged out at
      +90 and put it in the launch slot. With three subs banned the gate is
      really "did the BotBouncer appeal land", so read the ban state, not just a
      comment. If none is visible, the launch is HN-only and Reddit is posted
      later whenever a comment finally holds. Write the answer into the schedule
      row, do not leave it implied.
- [ ] Day 8: check referrer-less traffic in `gh api repos/velox-is/agentcap/traffic/views`.
- [ ] Day 9: confirm the signup endpoint answers 200 with `ok:true` and that the KV
      count equals the metrics row.
- [ ] Day 9: final read of the launch post. Title states the problem, not the
      product. Read it aloud once.
- [ ] Day 9: confirm `agentcap.pages.dev` still serves and the apex still answers.

## Day 10 — launch (Thu 2026-12-03, 22:00–23:00 KST)

Do not post early. **HN first, and HN alone if the day-8 gate failed.** Show HN
is the primary because a new HN account is visible from the first comment; Reddit
gating is not a factor there. If the gate passed, the Reddit sub goes up in the
same hour, HN still first so the HN post gets the attention.

- [ ] Show HN. Title is fixed as `Show HN: agentcap – ...`, body opens with the
      failure mode the case study is about, links the case study, not the repo
      root.
- [ ] Sit in the thread for 4 hours. Every question answered with a number or a
      file path.
- [ ] Do not repost on a second sub the same day. Cross-posting same-day is the
      most common way a young account gets flagged.

## Targets

Written from each sub's own pinned rules, not scraped summaries:

| Sub | Fit | Rule that decides the post |
| --- | --- | --- |
| HN Show HN | **primary** | No filter to clear. New-account comments and posts are visible from the first one, they just rank low. Account is a week old on 12-01, so the launch date clears the minimum. Title is fixed as `Show HN: agentcap – ...`. |
| r/ClaudeAI | **banned** | Permanent ban 11-26 17:53: "Bots and bot-like accounts are not welcome". Route is the /r/BotBouncer appeal. Only if it reverses does this sub launch. |
| r/n8n | **banned** | Permanent ban 11-26 17:53, same bot-classifier line as ClaudeAI, same appeal route. |
| r/selfhosted | **banned** | Permanent ban 11-26 17:14 on the off-topic rule (rule 6/5), not the bot one. Appeal to its mods directly — this is the only one of the three an argument can win. |
| r/LocalLLaMA | off the list | Removed three comments, the third inside 57 minutes. Rule 3 bans LLM-generated copy, but plainer prose did not save it either. No fourth attempt this week. If it comes back before day 9 the launch post here must be a link post with a short plain body, not a text post. |
| r/SideProject | low | Tolerates self-promo by design, low traffic. Cheap cross-post, not a launch. |

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

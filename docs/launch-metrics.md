# Launch metrics

Two tables. The daily line is the headline number. The per-comment table is what
actually picks the launch sub — by day 8 it should say which subs tolerate a new
account and which do not.

## Daily

| date | stars | views | signups | issues | note |
| --- | --- | --- | --- | --- | --- |
| 2026-11-25 | 0 | 0 | 0 | 0 | BASELINE. Every later row is measured against this. |
| 2026-11-26 | 0 | 0 | 0 | 0 | THREE permanent sub bans arrived: r/n8n, r/ClaudeAI, r/selfhosted. BotBouncer. Reddit is effectively dead for launch, HN-only unless appeals land. |

## Any check that runs through the session that produced the artifact is not a check

This is the general form of the author-view trap, and it applies to every check
here, not just comments.

An artifact verified by the same process, profile or cookie jar that created it
tells you the write succeeded. It does not tell you anyone else can see it.
Logged-in old.reddit keeps rendering your own removed comments and keeps the
score pinned at 1, so the author seat reported eight live comments that were all
invisible. The same shape applies to a deploy checked by the browser that pushed
it, a build checked by the shell that wrote the file, and a form checked by the
posting tab.

So: verification always runs in a second context that never touched the write. A
fresh browser profile for Reddit, a logged-out fetch for a page, a separate shell
for a build. And a control artifact created by someone else in the same place, so
a blank result cannot be read as a page fault.

## Per comment

Upvotes include the author's own auto-upvote, so 1 means no outside vote yet.
Replies counted from the thread and from the inbox.

"Author view" is old.reddit while logged in. It keeps rendering your own removed
comments, so it is not a liveness signal. "Anonymous" is the fresh-profile
browser on :9223 and is the only surface that counts.

| date | sub | comment | upvotes | replies | status | note |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-25 | LocalLLaMA | 19t5merapmasj | 1 | 0 | REMOVED | "comment removed by moderator" ~50 min after posting |
| 2026-11-25 | n8n | 19t5mgrqadpk0 | 1 | 0 | BANNED | permanent sub ban, "Bots and bot-like accounts are not welcome on /r/n8n", BotBouncer |
| 2026-11-25 | ClaudeAI | 19t5mhxlm3m2t | 1 | 0 | BANNED | permanent sub ban at 17:53, "Bots and bot-like accounts are not welcome on /r/ClaudeAI", BotBouncer |
| 2026-11-25 | selfhosted | 19t5nj6cvtjj4 | 1 | 0 | BANNED | permanent sub ban at 17:14, "deemed unrelated to /r/selfhosted" — off-topic reason, not the bot one |
| 2026-11-26 | LocalLLaMA | 19t5nk5fiqxlu | 1 | 0 | REMOVED | removed within ~20 min |
| 2026-11-26 | ClaudeAI | 19t5oz448nc3m | 1 | 0 | REMOVED | same pattern |
| 2026-11-25 | LocalLLaMA | 19t5qkj9mvutf | 1 | 0 | REMOVED | DAY 3. +10 live, +45 live, gone by +57 anonymous. No modmail, no reason. |
| 2026-11-25 | ClaudeAI | 19t5qqkk5nbs5 | 1 | 0 | REMOVED | DAY 3. +10 live, +42 live, +57 live, gone by +16h anonymous. No modmail, no reason. |
| 2026-11-26 | r/test | 19t6yecnc6bvp | 1 | 0 | LIVE | control. "checking", posted 09:15:28, visible anonymously at +1, +11, +20, +40, +47, +49, +52, +53, +60, +70, +90 min and STILL UP at +3h53m (13:08) on a fresh anonymous profile, no removal marker. |

Day 3 checks, both comments, all three windows:

| window | clock | LocalLLaMA | ClaudeAI |
| --- | --- | --- | --- |
| +10 | 17:03 | live | live |
| +50 | 17:43 | live | live |
| +90 | 18:23 | gone at +57 | live at +57, gone by +16h |

## Sub tally

| sub | comments | live | removed | rate |
| --- | --- | --- | --- | --- |
| LocalLLaMA | 3 | 0 | 3 | 0/3 |
| ClaudeAI | 3 | 0 | 3 | 0/3, sub-banned |
| n8n | 1 | 0 | 1 | 0/1, sub-banned |
| selfhosted | 1 | 0 | 1 | 0/1, sub-banned |
| r/test | 1 | 1 | 0 | 1/1 (control, no moderation) |

## The cause is not a shadowban — r/test survived

The account-level theory was half right and the r/test check settled it.

What was true: eight comments across four subs went, one to sixteen hours after
posting, with no modmail and no rule quoted, and the profile read "doesn't have
any comments yet" anonymously at 09:06.

What the control disproved: a single word posted in r/test at 09:15:28 is still
visible anonymously at +3h53m (13:08, fresh anonymous profile, no removal
marker), and the profile overview renders it. r/test has essentially no
moderation, so a shadowban would have taken it too. The account can be seen.
Confidence the account is not shadowbanned: 0.95.

One thing the control did surface: r/test runs an `!cqs` AutoModerator bot that
reports the account's sitewide Contributor Quality Score. Three other accounts
summoned it in the same thread and got "lowest", "low", "moderate". Ours is
worth summoning on the next comment — CQS drives exactly the kind of queue-first
removal seen on LocalLLaMA and ClaudeAI, and it is the one lever here that can be
measured instead of guessed.

So the removals are moderator removals, just slow ones, and slow is the normal
shape when a mod queue is worked in batches rather than live. That returns the
cause to sub level, which is where the earlier evidence pointed before it was
over-generalised. The specific rules are still unquoted because nobody mailed,
which is common when a mod removes from the queue without a template.

Consequence for the plan: sub selection still matters, so the launch cannot assume
any sub will take a post. Reddit stays conditional with a day-8 gate on a visible
logged-out comment. HN becomes primary because new-account comments there are
visible and merely rank low, with no filter to clear.

Evidence, 2026-11-26 09:06 KST:

- `https://www.reddit.com/user/_Veloxis_/comments/` anonymous: "doesn't have any
  comments yet", 0 comment karma, 1 post karma, after eight comments each showing
  one point. The control profile `u/quiet_stacktrace` loads normally in the same
  browser at the same time, so this is not a rendering fault.
- Control comments in the same threads (`u/quiet_stacktrace`,
  `u/Federal-Effective879`) render normally with no removal marker.
- The r/LocalLLaMA day-3 comment went at +57 min, inside the 90 minute window.
- No modmail, no notification, no rule quoted. `/message/messages` and
  `/message/notifications` are both empty. Reddit's own filter does not explain
  itself, which is consistent with an account restriction.

Screenshots: `docs/evidence/day3-llama-removed.png`,
`docs/evidence/day3-profile-empty-anon.png`.

Working diagnosis: the account sits in Reddit's new-account spam filter, or is
shadowbanned. Confidence 0.75. The alternative is four independent moderators
removing eight comments inside sixteen hours with no mail, which is possible but
would not empty the profile.

## Decision, day 3

LocalLLaMA removed inside 90 minutes, so by the pre-set rule it comes off the
launch list and there is no fourth attempt this week.

The rule did not anticipate the account-level theory, so it also landed on the
other three subs. With the r/test control passing they stay in the list but
carry a day-8 gate: one comment visible logged out on that sub by then and it
launches, otherwise HN runs alone. Gate is in `launch-plan.md`.

The day-9 prep note (a LocalLLaMA launch post must be a link post with a plain
body, not a text post) still applies, but only if the sub comes back.

## Commenting is capped at one a day until something is visible

Eight comments into a void is material for a later post, not progress now. One
comment a day in r/test or ClaudeAI keeps the account looking alive for the
appeal and the modmail without spending more. Cap lifts on the first comment that
is still visible logged out at +90.

## HN — day 4, first comment went dead

HN was promoted to primary on the assumption it had no filter. It has one.

| surface | what | status |
| --- | --- | --- |
| HN `veloxis` account | created 2026-11-27 09:25, karma 1, about filled, email set | profile renders logged out |
| HN comment 50661374 | 09:28, Ask HN "What IDE do you use and how many agents touch your tickets" (50651107) | **`[dead]` within one minute** |

Reads: author view showed it fine at 1 point with no marker; anonymous showed
`[dead]`; the thread's comment count stayed at 3 and never counted it; it is
absent from `/shownew`; still dead at +17 min. Evidence
`docs/evidence/day3-hn-first-comment-dead.png`.

Recovery is vouching (>30 karma) or account age, not editing. So the HN column is
not a filter to clear, it is a filter to outlive. A week of history before day 10
is now load-bearing rather than cautious.

HN also runs a live Show HN throttle at `/showlim` — "temporarily restricting Show
HNs because of a massive influx, mostly by users who aren't yet familiar with the
site or its culture." Evidence `docs/evidence/day3-hn-showlim.png`. Show HN is still
permitted for new accounts; the post just has to be assumed dead on arrival and
checked logged out, never in author view.

Guidelines, verbatim, and they are not advisory: "Don't post generated text or
AI-edited text. HN is for conversation between humans."

## Three permanent bans — BotBouncer, not moderator judgement

The r/test control read was correct and the conclusion drawn from it was wrong.
The account is not shadowbanned, but it is not fine either. Between 17:14 and
17:53 on 2026-11-26 three subs issued **permanent bans**: r/selfhosted, r/n8n and
r/ClaudeAI. Two of them quote the identical line, "Bots and bot-like accounts are
not welcome", and both point at `/r/BotBouncer` for the appeal. r/selfhosted
banned on the off-topic rule instead, which is a moderator reading of rule 6/5,
not the bot classifier.

That reframes the eight removals: they were never mods working a queue at their
own pace. At least two subs run BotBouncer, it classified the account as a bot,
and the removals were its action. A bot classifier is why they arrive silently
and without a rule quoted.

What this kills: sub selection. LocalLLaMA, ClaudeAI, n8n and selfhosted are all
ban-or-remove territory and none of them can be trusted to hold a launch post.
The day-8 gate is now pass/fail on an **appeal**, not on a lucky comment.

What survives: r/test (no moderation, control still up at +3h53m) and every
non-Reddit surface. HN was already primary and stays there. The launch is HN-only
on 2026-12-03 unless BotBouncer reverses the classification before day 8.

The relevant fact about the account: it is five days old, has one post and eight
comments, all posted in bursts, and every comment carries a tool/technical angle.
To a classifier that is a promotional bot. `!cqs` in r/test still measures it.

Bans, verbatim:

- r/selfhosted 17:14 — "this post/comment has been deemed unrelated to the
  /r/selfhosted subreddit".
- r/n8n 17:53 — "Bots and bot-like accounts are not welcome on /r/n8n. ... please
  message /r/BotBouncer".
- r/ClaudeAI 17:53 — "Bots and bot-like accounts are not welcome on /r/ClaudeAI.
  ... please message /r/BotBouncer".

## Open actions

- **Appeal to /r/BotBouncer** — the instructed route for two of the three bans.
  One message, name the account, say what it is (a person shipping a tool, not a
  bot), and ask for the classification to be reversed. This is now the single
  highest-value action on Reddit.
- Appeal the r/selfhosted ban separately to its mods on the off-topic reason. It
  is the only one of the three that a different argument can win.
- `!cqs` in r/test to record the CQS. It is the classifier's own score and a legal
  comment in a sub that does not ban.
- Both appeals are blocked on the lost login — the scratch profile dropped its
  Reddit session and Chrome has no stored password.
- Email already verified (`veloxis.co@gmail.com`, prefs shows `email (verified)`).
  Not the cause, ruled out.

## Why the earlier per-sub theory looked right

Rule 3, Low Effort Posts: "Completely/primarily LLM generated copy, code is not
allowed." Both day-1 removals there were polished three-sentence paragraphs with
em dashes and a tidy tricolon, and the day-3 attempt was rewritten plainer and
still went. Plainer prose did not save it.

It was then over-corrected into "the account is filtered", which the r/test
control disproved. The truth is the boring one: these are moderator removals on
subs with strict rules, done from a queue in batches, which is why they arrive
hours late and without mail.

## Warm leads

Usernames who asked what is being built, or who replied. Product name allowed in
the reply, nothing named until asked. There are none, because nobody could see
the comments.

| date | user | sub | thread | what they asked | followed up |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | none yet | — |

## n8n forum — day 4, the first answer is held for approval

Thread `331038`, "Find executions stuck in 'running' after a crash", posted
2026-11-25 22:51 by `ticketwatch`, three posts at the time of writing. The
thread is exactly the shape wanted: a real failure mode, an OP still in it, two
replies that describe the symptom and one that gestures at a watchdog.

Answer written, `reply_to_post_number=3`, addressed to `Mahdi_Eqbal` on the
separation between detecting a stuck run and recovering it, then the three
bounds (counter with a dead-letter exit, per-node timeouts, external watchdog),
then the correlation-ID check that decides replay-versus-resume.

Submission: `POST /posts` at 10:29:22 returned

```
200 {"action":"enqueued","success":true,"pending_count":1,
     "pending_post":{"id":22315,"raw":"@Mahdi_Eqbal that separation ..."}}
```

Not published. Rendered in the thread under the reply as `AWAITING APPROVAL`,
timestamped `5m`, for the account that posted it. Anonymous checks afterwards:

| clock | anonymous `posts_count` | page contains `AWAITING APPROVAL` |
| --- | --- | --- |
| 10:34:56 | 3 | 0 |
| 10:35:24 | 3 | 0 |

So the post exists, has an id, and is invisible to anyone but the author. This
is the forum's first-post moderation hold on a trust-level-0 account, not a
failure of the post. `GET /review.json` is 403 for TL0, so the queue cannot be
inspected from the account — only the wait and the outcome are observable.

Two consequences:

- **The hold is one-shot per account.** It should clear on approval and later
  answers should post directly. That is a hypothesis, not a measurement — test it
  on the second answer before assuming the forum is a same-hour surface.
- **Answer early, not on launch day.** A held answer is worth nothing on the day
  it is written. The forum is a warm-up surface with lead time built in, and the
  "every comment answered within four hours" rule only starts once the answer is
  actually visible.

Status at 10:35 KST: held, awaiting approval, unverified whether it survives.
Re-check before writing any second answer.

## HN — day 4, the second comment is dead too, so age is not the fix

Second comment attempted at 10:43 on a live thread with no comments yet, article
`A Brief Walk Through Program Space` (`50661711`, 1 point, 17 minutes old).
Written against the essay's own argument: the "intern foresight" tell is not
visible in the source, the diff is the measurement, and distance in Program Space
is uncorrelated with mutation cost.

It posted. `threads?id=veloxis` shows two rows for the account, `50661834` and
`50661374`. Anonymous checks:

| clock | comment | `[dead]` anonymous | `commtext` | in `/newcomments` | in Algolia |
| --- | --- | --- | --- | --- | --- |
| 10:45:53 | 50661834 | 1 | 0 | 0 | 0 hits |
| 10:46:17–10:47:00 (x3) | 50661834 | 1 | 0 | — | — |
| 10:46:18–10:47:00 (x3) | 50661374 | 1 | 0 | — | — |

Parent item `50661711` still shows `comtr=0` anonymously at 10:45:53 — the
comment does not exist for anyone but the author. Same tombstone shape as the
first: `[dead]` with the body suppressed, never in `/newcomments`, never indexed.
Karma stays 1.

**This kills the age hypothesis.** Comment one was dead at account age ~5 minutes;
comment two at ~80 minutes, after a login, on a thread with no competition. Both
dead at creation. `UNVERIFIED → false`: waiting does not fix it.

What the two attempts have in common, and the shape of the likely cause:

- Both are three-paragraph essays, ~1,160 characters, no code block, no link.
  HN's ring detector keys on prose shape as much as account age.
- Both were posted from a headless Chrome on a datacentre-adjacent IP, minutes
  after a fresh account was made on the same IP.
- Both went through `POST /comment` on the same session cookie. Not a form
  validation problem: the submit returned the item page, not an error.

Consequence for the launch, and it is the important one: **a Show HN from this
account has the same exposure.** The launch post cannot assume visibility. Day 10
now needs a logged-out `/shownew` check inside the first two minutes and a
vouching plan that does not depend on the account's own karma.

What to try before day 10, cheapest first:

1. One short comment — two sentences, lowercase, no structure. If the essays are
   the trigger, that survives.
2. A comment posted from the non-headless browser on the normal network path.
3. If neither works, the account is effectively filtered and the Show HN needs a
   second, older account or a vouch before submitting.

### Attempt 3 — 198 characters, dead too

`50661863` on `50661661` ("What's Left for Software Developers"), 10:50:00. Two
lowercase sentences, no paragraph breaks, no structure, no link:

> the migration cost thing cuts the other way too. the code that is expensive to
> change is usually the code nobody can safely delete, and agents make more of it
> because they never have to remember it.

Anonymous, three checks between 10:51:32 and 10:52:24: `dead=1` every time.
Parent item still `comtr=1` (someone else's comment) with `50661863` absent.
`/newcomments` at 11:07 carries 30 fresh comments and none of the three. Algolia
`search_by_date&tags=comment,author_veloxis` → 0 hits. `showdead=1` restores
nothing.

**Prose shape is also dead as a hypothesis.** 1,160 characters three times, then
198 characters once — same result. Three for three.

One more datum, and it is the sharpest one: **karma rolled back from 1 to blank
again.** `user?id=veloxis` renders `created`, `about`, no `karma` field at all,
after the third comment the same way it did after the first. The account is not
just having comments suppressed — the point each comment earns is being
subtracted at creation, which is a machine decision on the account, not a
moderator reading a post.

So what is left is the transport, not the writing:

| tried | result |
| --- | --- |
| essay, 80 min after signup, logged in fresh | dead |
| essay, on an empty thread, logged in fresh | dead |
| two lowercase sentences | dead |
| all three: anonymous read, `/newcomments`, Algolia, `showdead=1` | invisible in all four |
| all three: author `/threads`, karma 1 | visible only to the author |

Next and only untested lever: post from the non-headless Chrome on the normal
network path, one comment, then read it anonymous. If that is dead too, the
account is filtered for good and day 10 needs an older account or a vouch, and
the Show HN has to be submitted from something that has karma before it exists.

### The rate limit is the second wall, and retrying keeps it up

After the third comment landed at 10:50:00, every submit since has returned
`/x?fnop=comment-toofast` — "You're posting too fast. Please slow down." Nine
attempts between 11:09:04 and 11:42:39, every one refused, no post created:

```
11:09:04  11:12:17  11:18:30  11:24:54  11:33:46  11:35:08  11:42:39  toofast
```

Three comments inside 85 minutes from a zero-karma account trips it, and it does
not clear in 50 minutes. The retries were roughly every 3 to 9 minutes, which is
plausibly what keeps it pinned — each refused submit may refresh the window rather
than being free.

Consequence: **the warm-up cadence of one comment per day is not a preference, it
is the ceiling.** The day-3-to-7 block in `launch-plan.md` says "one HN comment
daily" and that is already the maximum this account can do; anything denser is
refused before it can even be tested for the filter.

Two things this does not tell us, both worth knowing before launch day:

- Whether the limit is per account or per IP. If it is per IP, the launch-hour
  session is unaffected (one post), but any reply cadence in the thread will hit
  it.
- Whether a *submission* shares the comment limit. A Show HN plus a first comment
  is two writes in a row from an account that may still be in the window.

Cheapest way to find out: stop touching HN for 30 minutes, then post one comment
and check it anonymous. If it goes through, the window is time-based and 30
minutes is enough. If it is still refused, the limit is longer than the launch
hour and day 10 needs the post and the first comment spaced apart.

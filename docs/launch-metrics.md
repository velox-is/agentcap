# Launch metrics

Two tables. The daily line is the headline number. The per-comment table is what
actually picks the launch sub — by day 8 it should say which subs tolerate a new
account and which do not.

## Daily

| date | stars | views | signups | issues | note |
| --- | --- | --- | --- | --- | --- |
| 2026-11-25 | 0 | 0 | 0 | 0 | BASELINE. Every later row is measured against this. |
| 2026-11-26 | 0 | 0 | 0 | 0 | all eight warm-up comments removed. Cause is account level, not sub rules. |

## Per comment

Upvotes include the author's own auto-upvote, so 1 means no outside vote yet.
Replies counted from the thread and from the inbox.

"Author view" is old.reddit while logged in. It keeps rendering your own removed
comments, so it is not a liveness signal. "Anonymous" is the fresh-profile
browser on :9223 and is the only surface that counts.

| date | sub | comment | upvotes | replies | status | note |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-25 | LocalLLaMA | 19t5merapmasj | 1 | 0 | REMOVED | "comment removed by moderator" ~50 min after posting |
| 2026-11-25 | n8n | 19t5mgrqadpk0 | 1 | 0 | REMOVED | live on author view at +17h, gone anonymously by +16h |
| 2026-11-25 | ClaudeAI | 19t5mhxlm3m2t | 1 | 0 | REMOVED | same pattern |
| 2026-11-26 | selfhosted | 19t5nj6cvtjj4 | 1 | 0 | REMOVED | same pattern |
| 2026-11-26 | LocalLLaMA | 19t5nk5fiqxlu | 1 | 0 | REMOVED | removed within ~20 min |
| 2026-11-26 | ClaudeAI | 19t5oz448nc3m | 1 | 0 | REMOVED | same pattern |
| 2026-11-25 | LocalLLaMA | 19t5qkj9mvutf | 1 | 0 | REMOVED | DAY 3. +10 live, +45 live, gone by +57 anonymous. No modmail, no reason. |
| 2026-11-25 | ClaudeAI | 19t5qqkk5nbs5 | 1 | 0 | REMOVED | DAY 3. +10 live, +42 live, +57 live, gone by +16h anonymous. No modmail, no reason. |

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
| ClaudeAI | 3 | 0 | 3 | 0/3 |
| n8n | 1 | 0 | 1 | 0/1 |
| selfhosted | 1 | 0 | 1 | 0/1 |

## The cause is the account, not the sub

Rule 3 was the wrong hypothesis. It was built on two LocalLLaMA removals and it
predicted ClaudeAI would keep taking comments. It did not. Every comment on all
four subs is now gone, and the removals are delayed by one to sixteen hours,
which is a spam-filter shape rather than a moderator shape.

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

The rule did not anticipate the account-level cause, so it also lands on the
other three subs. They are not dropped yet. They stay listed as unreliable until
the filter clears or an appeal succeeds. If it clears before day 9 the list goes
back to four subs with LocalLLaMA still last.

The day-9 prep note (a LocalLLaMA launch post must be a link post with a plain
body, not a text post) still applies, but only if the sub comes back.

## Why the earlier per-sub theory looked right

Rule 3, Low Effort Posts: "Completely/primarily LLM generated copy, code is not
allowed." Both day-1 removals there were polished three-sentence paragraphs with
em dashes and a tidy tricolon, and the day-3 attempt was rewritten plainer and
still went. Plainer prose did not save it, which is the tell that the prose was
never the variable.

## Warm leads

Usernames who asked what is being built, or who replied. Product name allowed in
the reply, nothing named until asked. There are none, because nobody could see
the comments.

| date | user | sub | thread | what they asked | followed up |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | none yet | — |

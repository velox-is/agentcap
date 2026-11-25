# Launch metrics

Two tables. The daily line is the headline number. The per-comment table is what
actually picks the launch sub — by day 8 it should say which subs tolerate a new
account and which do not.

## Daily

| date | stars | views | signups | issues | note |
| --- | --- | --- | --- | --- | --- |
| 2026-11-25 | 0 | 0 | 0 | 0 | BASELINE. Every later row is measured against this. |

## Per comment

Upvotes include the author's own auto-upvote, so 1 means no outside vote yet.
Replies counted from the thread and from the inbox.

| date | sub | comment | upvotes | replies | status | note |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-25 | LocalLLaMA | 19t5merapmasj | 1 | 0 | REMOVED | "comment removed by moderator" ~50 min after posting |
| 2026-11-25 | n8n | 19t5mgrqadpk0 | 1 | 0 | live | |
| 2026-11-25 | ClaudeAI | 19t5mhxlm3m2t | 1 | 0 | live | |
| 2026-11-26 | selfhosted | 19t5nj6cvtjj4 | 1 | 0 | live | |
| 2026-11-26 | LocalLLaMA | 19t5nk5fiqxlu | 1 | 0 | REMOVED | removed within ~20 min |
| 2026-11-26 | ClaudeAI | 19t5oz448nc3m | 1 | 0 | live | |

## Sub tally

| sub | comments | live | removed | rate |
| --- | --- | --- | --- | --- |
| LocalLLaMA | 2 | 0 | 2 | 0/2 |
| ClaudeAI | 2 | 2 | 0 | 2/2 |
| n8n | 1 | 1 | 0 | 1/1 |
| selfhosted | 1 | 1 | 0 | 1/1 |

## Why LocalLLaMA removes these

Rule 3, Low Effort Posts: "Completely/primarily LLM generated copy, code is not
allowed." Both removed comments were polished three-sentence paragraphs with em
dashes and a tidy tricolon. ClaudeAI has no such rule and took both.

Hypothesis, not yet tested: LocalLLaMA mods pattern-match on the em dash and the
"X is the symptom, not a setting" construction. Next attempt there should be
plainer — shorter sentences, fewer dashes, a number from a real run, and a name or
a command instead of a rhetorical frame.

## Warm leads

Usernames who asked what is being built, or who replied. Product name allowed in
the reply, nothing named until asked.

| date | user | sub | thread | what they asked | followed up |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | none yet | — |

# Day 1 comments — 2026-11-25

Three comments, no links, no product name, one number each. Threads are all under 24 hours. Post from the Veloxis account.

Check each in a private window after posting. Filtered is not a failure; a duplicate repost looks worse than a gap. Wait a few hours before retrying one.

## 1 — r/LocalLLaMA

<https://www.reddit.com/r/LocalLLaMA/comments/1y4xrrp/why_token_use_stats_are_fugazi_fable_use_gpt_to/>

> The gap between flat subscription and metered API is where the actual design decisions live, and most of them only get made after someone sees a bill. Same habits at $3/Mtok — six agents holding 30k of context, three retries each — is about $0.27 a cycle, so twenty cycles an hour is $5.40, roughly 7,700원, to move nothing forward. The number is survivable; what gets you is that nothing inside the loop says it is happening until the invoice does.

## 2 — r/n8n

<https://www.reddit.com/r/n8n/comments/1y4w2tc/where_the_qa_gate_goes_in_a_4agent_research/>

> The two-pass ceiling and "refusing is a valid output" are the parts worth copying out of this. One thing I would add on the control-flow side: a single writer for the counter, because two parallel branches comparing against the same remaining budget will both spend it and each will conclude it stayed under. And the terminal state has to mean stuck rather than retry — a loop that can only retry has no way to finish except by exhausting the retry count.

## 3 — r/ClaudeAI

<https://www.reddit.com/r/ClaudeAI/comments/1y4xo5o/792_agents_jumped_to_852_agents_am_i_doing/>

> 852 is the symptom, not a setting — the count grows when each step hands the next one the transcript instead of an artifact. Have workers read an input file and write a result file, have the reviewer read the diff and never the conversation, and the context stops compounding per hop. On the API question: the workflow shape matters more than the billing model, because a step ceiling and a per-task token count stop the growth either way, and the subscription gives you neither.

## Log after posting

| # | sub | thread | landed? | note |
| --- | --- | --- | --- | --- |
| 1 | LocalLLaMA | token use stats | | |
| 2 | n8n | QA gate placement | | |
| 3 | ClaudeAI | 792 to 852 agents | | |

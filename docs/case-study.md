# A cap is only a cap if the number it checks is true

`agentcap` is a local proxy that counts what agents spend and kills them when they run past a budget. The interesting part is not the kill. It is that the token number the kill reads has to be correct, and the hard case is usage that arrives after the decision has already been made.

This is a run, not an illustration. `scripts/measure-late.mjs` starts the real CLI against a mock upstream, caps a task at **100 tokens**, lets the stream breach, then reports three real spans against the now-dead task over OTLP. The numbers below are that script's output.

## What the run produced

```
cap                       100 tokens, 0.0002 USD
tokens at breach          210
tokens that arrived late  1120   (3 spans)
tokens total              1330
task status               stuck
breach_reason             max_tokens

late span 1   420 tokens   capCrossed: null      alreadyOver: [max_tokens]
late span 2   370 tokens   capCrossed: max_usd   alreadyOver: [max_tokens]
late span 3   330 tokens   capCrossed: null      alreadyOver: [max_tokens, max_usd]
```

Both headline numbers are reported because either alone is a lie. "Capped at 100" while 1,330 were spent is the honest headline, and the task is `stuck` the whole way after 210.

The three late spans are the interesting part. The task is already dead on `max_tokens` when they land, so a naive "which cap is breached?" answer says `max_tokens` every time. Span 2 is the one that actually breaks `max_usd`, and it is the only one that reports `max_usd`.

## Why it is 210 and not 100

The breach check does not run on every chunk. It runs every 4 chunks or every 250 ms, whichever comes first (D16), because a database read per chunk of a fast stream is waste and kill latency is bounded at a quarter second either way.

So the cap is a **boundary check, not a mid-token interrupt**: the frame that crosses 100 is delivered, the check fires at the next poll, and the stream closes. Here the mock streams cumulative usage 70 / 140 / 210 at 200 ms intervals, so two frames land inside the polling window and the breach is detected at 210.

That is 110 tokens of overshoot — and the number that matters is the absolute one, not the 110%. Overshoot is bounded by **tokens per chunk × chunks per polling window**: at this mock's 70-token chunks the ceiling is 280 tokens, and it is flat in tokens regardless of cap size. 110 tokens is a scary 110% on a 100-token cap and roughly 0.1% on a 100,000-token one. A reader who sees only "cap 100, spent 210" concludes the cap is decorative. It is not; it is a boundary check with a fixed, measurable slack that the polling interval sets and the cap size does not.

The cap also cannot interrupt mid-chunk: the frame that crosses the limit is already delivered, so the check fires at the next poll and closes the stream. The alternative, a database read per chunk, buys precision the provider's own usage reporting does not have.

## Why 1120 tokens arrived after the task was dead

The proxy can only count what flows through the proxy. An agent that emits OpenTelemetry spans reports usage the proxy never saw, and a batched exporter flushes on its own schedule, routinely after the task is already dead.

The old behaviour overloaded one field to answer two questions. `reason` said "why is this usage late" and was also the only place the death reason lived, so a task killed on `max_seconds` started reporting `max_tokens` once late spans came in, and a reader concluded the token cap had leaked.

Now the questions are separate (D51, D52):

- `tasks.breach_reason` is why the task died. Written once, at the moment it is first marked dead, `COALESCE`d so a later verdict cannot overwrite it.
- The `late_usage` event describes the lateness: `tokens`, `source`, `taskStatusAtArrival`, `currentVerdict`, `arrivedAfterMs`, `wouldExceed`, `capCrossed`, `alreadyOver`.

`wouldExceed` and its two companions answer whether the cap was accurate. The naive version returned the first breached cap in priority order, which is backwards: a task already stuck on `max_tokens` whose late tokens finally break `max_usd` reported `max_tokens` again. So the comparison now returns the **set** of breached caps and diffs it against the set already breached before the span landed. The new member is the attribution — `capCrossed: "max_usd"`, `alreadyOver: ["max_tokens"]` — and `capCrossed` is `null` when these tokens cross nothing new.

`arrivedAfterMs` is ingest time minus the span's own end timestamp, so a span that sat in an exporter queue for four minutes looks like a straggler instead of a slow request. It is `null`, not `0`, when the exporter sent no end timestamp — the dashboard renders `late ?` for that and an `otel_missing_end_time` event is logged once per exporter, because "instant" and "unknown" are different facts.

## What still holds

- Late usage is applied, never dropped. A budget tool that discards real spend is worse than one that overshoots.
- Totals stay monotone. Late usage only ever adds.
- No second breach event. The death is recorded once; later arrivals are marked, not re-announced.
- Admission refuses the next request with the recorded reason. In the run, the fourth request came back `{"error":"budget_exceeded","task":"...","reason":"max_tokens"}` and added no tokens: `steps` stayed at 4 and the task total did not move.

## The dashboard shows both numbers

The task row renders `breach_reason` in the status column, and the token cell carries a `+N late` marker next to the total. The feed marks the late row `late`, with the lag in seconds or `late ?` when the exporter sent no end timestamp.

The GIF at the top of the README is a separate, illustrative run recorded with `scripts/gif-demo.mjs`, not the measurement above. Every number in this document comes from `scripts/measure-late.mjs`; the GIF only shows the shapes the dashboard renders.

## What this does not solve

A span has no way to be stopped. It is reported after the fact, so late tokens are spend you have already incurred. The cap cannot prevent them; it can only report them accurately. Preventing them means the agent routing its calls through the proxy, which is the whole reason the proxy is the product.

Overshoot inside the polling window is real and accepted. It is bounded, it is measurable, and the alternative, a database read per chunk, buys precision the provider's own usage reporting does not have.

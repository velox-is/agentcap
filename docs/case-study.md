# A cap is only a cap if the number it checks is true

`agentcap` is a local proxy that counts what agents spend and kills them when they run past a budget. The interesting part is not the kill. It is that the token number the kill reads has to be correct, and the hard case is usage that arrives after the decision has already been made.

This is a run, not an illustration. `scripts/measure-late.mjs` starts the real CLI against a mock upstream, caps a task at **100 tokens**, lets the stream breach, then reports three real spans against the now-dead task over OTLP. The numbers below are that script's output.

## What the run produced

```
cap                       100
tokens at breach          210
tokens that arrived late  1120   (3 spans)
tokens total              1330
task status               stuck
breach_reason             max_tokens
```

Both numbers are reported because either alone is a lie. "Capped at 100" while 1,330 were spent is the honest headline; it is 13.3x the cap, and the task is `stuck` the whole way after 210.

## Why it is 210 and not 100

The breach check does not run on every chunk. It runs every 4 chunks or every 250 ms, whichever comes first (D16), because a database read per chunk of a fast stream is waste and kill latency is bounded at a quarter second either way.

So the cap is a **boundary check, not a mid-token interrupt**: the frame that crosses 100 is delivered, the check fires at the next poll, and the stream closes. Here the mock streams cumulative usage 70 / 140 / 210 at 200 ms intervals, so two frames land inside the polling window and the breach is detected at 210.

That is 110 tokens of overshoot, a little over one frame's worth. It is bounded by the polling window, not by a whole request, which is what the old per-request accumulator allowed.

## Why 1120 tokens arrived after the task was dead

The proxy can only count what flows through the proxy. An agent that emits OpenTelemetry spans reports usage the proxy never saw, and a batched exporter flushes on its own schedule, routinely after the task is already dead.

The old behaviour overloaded one field to answer two questions. `reason` said "why is this usage late" and was also the only place the death reason lived, so a task killed on `max_seconds` started reporting `max_tokens` once late spans came in, and a reader concluded the token cap had leaked.

Now the questions are separate (D51, D52):

- `tasks.breach_reason` is why the task died. Written once, at the moment it is first marked dead, `COALESCE`d so a later verdict cannot overwrite it.
- The `late_usage` event describes the lateness: `tokens`, `source`, `taskStatusAtArrival`, `currentVerdict`, `arrivedAfterMs`, `wouldExceed`.

`wouldExceed` is the one that answers whether the cap was accurate. It re-runs the cap comparison against the totals *before* the span landed, using a new `exceeds()` that skips the already-dead short-circuit. In this run it returns `max_tokens`, which says the tokens were genuinely over budget, not that a `max_seconds` kill got relabelled.

`arrivedAfterMs` is ingest time minus the span's own end timestamp. A span that sat in an exporter queue for four minutes looks like a straggler instead of a slow request.

## What still holds

- Late usage is applied, never dropped. A budget tool that discards real spend is worse than one that overshoots.
- Totals stay monotone. Late usage only ever adds.
- No second breach event. The death is recorded once; later arrivals are marked, not re-announced.
- Admission refuses the next request with the recorded reason. In the run, the fourth request came back `{"error":"budget_exceeded","task":"...","reason":"max_tokens"}` and added no tokens: `steps` stayed at 4 and the task total did not move.

## The dashboard shows both numbers

The task row renders `breach_reason` in the status column, and the token cell carries a `+N late` marker next to the total. The feed marks the late row `late`. The GIF in the README is a live capture of that state; it is a separate run, so its late count differs from the one measured above.

## What this does not solve

A span has no way to be stopped. It is reported after the fact, so late tokens are spend you have already incurred. The cap cannot prevent them; it can only report them accurately. Preventing them means the agent routing its calls through the proxy, which is the whole reason the proxy is the product.

Overshoot inside the polling window is real and accepted. It is bounded, it is measurable, and the alternative, a database read per chunk, buys precision the provider's own usage reporting does not have.

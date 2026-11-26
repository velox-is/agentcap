# BotBouncer appeal — procedure, constraints, message

Read this before sending anything. The appeal is one-shot and the clock matters.

## What the thing is

BotBouncer is a Developer Platform app that classifies accounts as bot / spam /
karma-farm on a sitewide basis. Subreddits install it. When it classifies you, every
sub running it bans you automatically, silently, and with the same wording. That is
exactly the signature we saw: identical text on r/n8n and r/ClaudeAI, minutes apart,
no human involved.

The classification lives on the account, not on the comment. Unbanning on one sub
does not help — the operator docs say the sub-level unban "does not prevent the user
from being banned from other subreddits", while an appeal that succeeds at
r/BotBouncer lifts the bans everywhere automatically.

So: the appeal at r/BotBouncer is the only move that matters. Arguing with
individual subs is cosmetic.

## Constraints, from operator docs and from people who have appealed

- Route is modmail to r/BotBouncer: `https://www.reddit.com/message/compose?to=r%2FBotBouncer`.
  Not a comment, not a post, not a reply to the ban message.
- Classification is a mix of automated and human review. A human reads the appeal
  and looks at the profile.
- One appeal. A rejected appeal produces an automated "you have already appealed"
  reply and effectively closes the door. A second attempt needs a real track record
  behind it first — the consistent advice is a month of genuine commenting before
  reappealing.
- The seven-day mute that follows a rejection is the visible part; the month is the
  real wait.
- Success looks like the status flipping from `Banned` to `Organic`, which lifts
  every sub ban at once.

## What that means for the launch date

Launch is 2026-12-03. Day 8 gate is 2026-12-01. The account is 5 days old with 8
comments, all posted within two days, all tool-angled, and the profile is empty
logged out because the comments were removed.

Two options, and they are mutually exclusive:

1. Appeal now. Fastest possible route to a launchable Reddit sub. Risk: thin
   history, a reviewer opens an empty-looking profile, rejects, and the door shuts
   for a month — which lands after launch.
2. Build history first, appeal on day 7. A week of visible comments in subs that do
   not run BotBouncer, then appeal with something to look at. Cost: the verdict
   lands around launch, too late to change the plan.

Recommendation: appeal now, and in parallel keep commenting. The profile is not as
empty as it looks — the r/test control is public and visible, so the reviewer can see
a live comment by the account. A rejection is survivable because HN carries the
launch regardless. Building a week of history first only pays off if the appeal is
expected to fail, and there is no evidence for that yet.

## Rules for the message

- Short. A reviewer reads dozens of these.
- Name the account, name the classification, ask for `Organic`.
- Say what the account is for and who runs it — a person, one tool, a real product
  with a repo.
- Give the reviewer something to check: the visible r/test comment, the repo, the
  fact that the removed comments were substantive rather than link drops.
- Address the pattern honestly. Eight comments in two days on a five-day-old account
  does look like a bot. Do not get defensive about it.
- No links in the message body other than what a reviewer needs. BotBouncer reviewers
  are not launch targets.
- No promise of future behaviour beyond what is true.

## Message, ready to paste

> Subject: Appeal: u/_Veloxis_ classified as bot
>
> Hello,
>
> u/_Veloxis_ has been classified as a bot and is now permanently banned from
> r/n8n and r/ClaudeAI, and separately from r/selfhosted. Both bot ban messages point
> here, so this is the appeal.
>
> The account is mine. I am a person, in Korea, and it exists for one reason: I am
> about to release a small open-source tool called agentcap and I was warming the
> account up before launch on 2026-12-03.
>
> I understand why it looks automated. The account is five days old, everything was
> posted in two bursts, and every comment has a technical or tool angle. That is a
> bot shape.
>
> What is actually behind it: the tool is real and finished, and the comments were
> written from the code rather than from the marketing. r/ClaudeAI got a token-budget
> breakdown with the cap arithmetic in it; r/LocalLLaMA got a YaRN and rope-scaling
> correction with a `llama-cli --rope-scaling none` command; the r/selfhosted one
> described the loopback-only bind.
>
> Something to check: u/_Veloxis_ has one comment still live, in r/test, posted
> 2026-11-26 at 09:15 KST, permalink
> https://www.reddit.com/r/test/comments/1y5kora/testt_here/19t6yecnc6bvp/
>
> The repo, for the record: https://github.com/velox-is/agentcap
>
> Could the classification be reviewed and set to Organic? Happy to answer anything.
>
> Thanks.

## After sending

- Log the send time here and in `launch-metrics.md`.
- Check the r/BotBouncer overview post for the account
  (`/r/BotBouncer/comments/1y5203m/overview_for_veloxis/`) — the flair flips on a
  successful appeal.
- Do not send a second appeal inside seven days. If it is rejected, the next one is
  after a month of real commenting, and the launch goes HN-only.
- If it is accepted, re-read the ban state on all three subs before trusting it, and
  run a fresh comment on one of them before day 8 rather than assuming.

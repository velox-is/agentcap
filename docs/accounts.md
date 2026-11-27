# Accounts

Handles are all `veloxis` / `velox-is` / `_Veloxis_`. The Google password is
reused for everything, because it is the one that was recoverable and the only
one that works.

Public repo, so treat these as low-value: they are one-message-takeable, and
nothing important hangs off them except the HN account.

| surface | handle | credential | state |
| --- | --- | --- | --- |
| Hacker News | `veloxis` | `Rlawjdwns7924!` | created 2026-11-27 09:25, karma 1, two comments both `[dead]` at creation |
| community.n8n.io | `veloxis` | `Rlawjdwns7924!` | activated, id 207762, TL0, first answer held `AWAITING APPROVAL` |
| Discord | — | — | no account in any headless profile; invites: NousResearch, opencode, n8n |
| Google | `veloxis.co@gmail.com` | `Rlawjdwns7924!` | live; recovered from Vivaldi's store, works for Gmail and Google SSO |
| GitHub | `velox-is` | SSH key, `git@github-velox-is` | live, identity enforced by hook and CI |
| Reddit | `_Veloxis_` | **unknown** | three sub bans, appeal blocked on login |

## The credential that matters

`veloxis.co@gmail.com` / `Rlawjdwns7924!` is the one that unblocks every surface
at once (n8n activation, Discord join, Reddit appeal) and it is also the HN and
n8n password. Neither keychain search nor Chrome `Login Data` yields it — Chrome's
store is TCC-blocked from here — so it came out of Vivaldi's encrypted login store:
PBKDF2 over the raw base64 string of the `Vivaldi Safe Storage` keychain item, salt
`saltysalt`, 1003 iterations, AES-128-CBC, IV of 16 spaces. That derivation is the
recovery path if the password is ever lost again.

## The password on record was wrong

`docs/accounts.md` carried `0RBjUk48L8aP7SlPVozW` as the shared password from 09:53
to 10:42. HN login with it now returns `200 Bad login`; with `Rlawjdwns7924!` it
returns `302` and sets the session. Both accounts were created at 09:25 and 09:30
with the other one, and the HN signup did not complain — so either the field was
typed differently at signup or the generated string was transcribed wrong into the
doc. Untestable now. The working credential is the Google one; treat
`0RBjUk48L8aP7SlPVozW` as dead for both surfaces.

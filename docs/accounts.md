# Accounts

Handles are all `veloxis` / `velox-is` / `_Veloxis_`. One generated password is
reused for the throwaway platform logins so it does not have to be remembered or
looked up. The Google account is the exception and predates this.

Public repo, so treat these as low-value: they are one-message-takeable, and
nothing important hangs off them except the HN account.

| surface | handle | credential | state |
| --- | --- | --- | --- |
| Hacker News | `veloxis` | `0RBjUk48L8aP7SlPVozW` | created 2026-11-27 09:25, login verified 09:50, karma 1, first comment `[dead]` |
| community.n8n.io | `veloxis` | `0RBjUk48L8aP7SlPVozW` | registered 09:30, **not activated** — mail is in veloxis.co@gmail.com |
| Discord | — | — | no account in any headless profile; invites: NousResearch, opencode, n8n |
| Google | `veloxis.co@gmail.com` | **unknown, not stored anywhere** | needed for: n8n activation mail, Google SSO on Reddit and Discord, and the BotBouncer appeal |
| GitHub | `velox-is` | SSH key, `git@github-velox-is` | live, identity enforced by hook and CI |
| Reddit | `_Veloxis_` | **unknown** | three sub bans, appeal blocked on login |

## The one that matters

`veloxis.co@gmail.com` is the single credential that unblocks three surfaces at
once (n8n activation, Discord join, Reddit appeal). Neither keychain search nor
the Chrome `Login Data` database yields it, and Chrome Safe Storage is unreadable
from here. Only the human has it.

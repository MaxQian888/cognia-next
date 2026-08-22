---
"cognia-next": minor
---

IM bots now advertise what THEY can do, not what their platform can do.

Every capability check — the tools the model is offered, the "load earlier messages" button, the reply-quoting toggle, the permission ceiling — read a static per-platform table. That table describes what an adapter _implements_, and its own comment warned that a declared flag "is platform-wide". So a Slack workspace that never granted `files:write` was still offered file uploads that answered `missing_scope`; a OneBot instance running Lagrange was offered reactions only NapCat implements; Slack's typing indicator was advertised on installs where it is a documented no-op.

The instance-level truth already existed and was never read. Slack persists its granted OAuth scopes and only ever displayed them. OneBot probes its upstream and stores which non-standard actions it supports, under a comment saying a capability view "can show what the upstream supports" — nothing showed it. A new projection reads exactly that stored evidence and reports, per capability, whether it works and why not: the scope you would need to grant, the upstream action your bot's server lacks, the setting that is off, or the conversation scene where it does exist.

Absent evidence never suppresses anything: a bot configured with a hand-pasted token records no scopes and keeps every capability, because refusing to guess is the point.

**Slack installs need to re-authorize to upload files, react, and pin.** The consent screen only ever requested four scopes while the adapter advertised uploads, reactions and pins, so those never actually worked on an OAuth install — they failed at send time instead of being hidden. The three scopes are now requested; until you re-authorize, the capabilities are correctly hidden rather than silently failing. History reads into private channels and group DMs are deliberately still not requested — that widens what the bot can read rather than fixing something it already claimed.

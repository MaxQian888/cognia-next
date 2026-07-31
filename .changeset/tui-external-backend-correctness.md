---
"cognia-next": patch
---

`cognia-agent chat --backend codex|claude-code` no longer kills long turns or silently forgets the conversation. Turns were being capped by a hard 60-second wall clock inherited from the shared agent manager, so most real Codex and Claude Code work was cancelled mid-flight; worse, setting `streamIdleTimeoutMs` to `0` to "disable" the limit tightened it to 30 seconds. External turns are now bounded the same way built-in ones are — by silence rather than by elapsed time, with the watchdog arming only after the first streamed event and pausing while a permission prompt is waiting on you.

Any failure on an external backend also used to be read as "the session is dead", tearing down the agent and restarting it with an empty history while the transcript above still showed the whole conversation — so follow-up questions were answered with no context and nothing said so. Failures are now classified: a refused tool, a provider error or a stalled stream keeps the session and its context, and when the agent genuinely does have to be restarted the transcript says so in a permanent line.

Other fixes in this area: an unknown `--backend` id now reports the error instead of swallowing your message; the "sandbox launcher is unavailable" error is written for whoever is reading it, with the maintainer build command shown only inside a repo checkout; `/doctor` reports sandbox and platform readiness alongside the command check, so a backend that cannot possibly start no longer shows a green tick; and a single external file edit renders as one card carrying its diff instead of a prose-titled card plus a duplicate — external tool cards now keep diff rendering, clickable paths and namespace badges, and a re-sent update no longer stacks copies.

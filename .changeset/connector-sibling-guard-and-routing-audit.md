---
"cognia-next": patch
---

**When a bot decides not to answer, you can now see why — and the message is no longer thrown away.**

Multi-bot setups have an anti-loop guard that stops two of your own bots @-mentioning each other forever. It ran too early: a message it suppressed was discarded before anything was written down, so the conversation simply had a gap, and the per-chat budget for bot-to-bot replies was spent before anything had decided the message would even be answered — a bot posting into a muted chat, or one whose trigger matched nothing, still used it up.

The guard now runs after the message is stored and after the reply decision, so suppressed messages stay in history with a recorded reason, and the budget is only spent on a reply that is actually about to be sent. Messages that are received but match no trigger are recorded as such too, instead of vanishing into a generic "history only".

The guard also no longer assumes an unrecognised sender is a person. Bots confirm their own account on every start, so if one of your same-platform bots cannot be identified at all, the others hold back and name it rather than risking a loop.

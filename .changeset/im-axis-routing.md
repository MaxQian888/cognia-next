---
"cognia-next": minor
---

IM conversations now route on the agent-mode axes they actually store, not on the three-value `mode` mirror. A conversation handed to a human, or escalated by an SLA step, is honoured even when the mirror still says the bot should answer; `confirm` and `autopilot` — which have no legacy spelling — became reachable at all. A character that ships a recommended platform mode now takes effect, and settings read-outs label it as coming from the character rather than from the bot's defaults.

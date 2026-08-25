---
"cognia-next": minor
---

A template can now remember which agent, team and workspace it belongs with.

Saving a message offers to keep the current conversation's setup — agent, team, workspace, model, mode — alongside the body. Insert that template somewhere else and a bar appears above the composer naming exactly what differs, with a button to start a fresh conversation configured the way the template asks.

It never re-points the conversation you are already in. Half a transcript produced by one agent and half by another, with nothing in the history saying when it changed, is worse than an extra click — so the bar offers, and the current conversation is left exactly as it was. It also only appears when something would genuinely differ; a bar that warns about non-changes is one people learn to dismiss unread.

Also fixes template ids colliding when two templates are saved in the same millisecond, which silently overwrote the first.

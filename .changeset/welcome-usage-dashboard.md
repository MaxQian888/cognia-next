---
"cognia-next": minor
---

Add a customizable usage dashboard to the chat welcome page — stat tiles (sessions, turns, tokens, cost, active days, streaks, peak hour, top model), a calendar heatmap, and a per-model breakdown over a 7/30/90-day window. Every figure is derived from the same `sessionUsage` aggregation the Subscription → Usage tab uses, and both surfaces now draw the same heatmap component. Tiles, the heatmap, the window and the active view are persisted per user; the ✕ hides the panel and Settings → Appearance → Personalization restores it.

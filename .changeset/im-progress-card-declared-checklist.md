---
"cognia-next": minor
---

IM progress cards now declare the whole plan up front instead of growing one line at a time. When a message kicks off an Agent Team run or a visual workflow in Slack / Lark / Telegram / Discord / OneBot, the in-place-edited status card lists every step it intends to run — not-yet-started steps show as `◻` and tick over to `▶` / `✓` / `✗` / `⊘` as the run progresses, so the thread shows what is coming rather than only what has already happened. Steps are listed in execution (topological) order and keep that order as they transition, so the card never reshuffles mid-run. Steps that never ran on a failed or cancelled run stay `◻`, making it obvious where the run stopped. On very large workflows the declared tail is capped so the card can't exceed the platform's per-message limits, while already-executed steps continue to be listed in full.

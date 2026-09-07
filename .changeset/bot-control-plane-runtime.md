---
"cognia-next": minor
---

Bots can now actually run. A crashed host no longer strands a delivery or retires its concurrency key forever, the agent-turn executor resolves a working directory instead of refusing every run, a Bot waiting on a human leaves the queue instead of stalling every other Bot on the host, schedule/poll/derived-state triggers fire, `waitForEvent` can be woken, and all five event sources have producers, including IM messages reaching a plugin-declared Bot.

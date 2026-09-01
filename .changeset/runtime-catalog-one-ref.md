---
"cognia-next": patch
---

The composer's runtime chip now names the engine that will actually run the turn. It used to describe the built-in lane as "Built-in Anthropic SDK sidecar" under every provider, including in its accessible name, where the glyph-only chip makes that the only wording a screen reader gets. On a DeepSeek or OpenAI session the turn runs on the AI SDK, and the row says so.

Behind it, the runtime choice became one value instead of three separate persisted fields that could disagree, so the lane can no longer end up naming a target it does not have. A stored selection that pointed at a deleted or switched-off agent still falls back to the built-in runtime, and one that is only waiting on a plugin adapter is still preserved across restarts.

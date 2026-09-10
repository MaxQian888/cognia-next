---
"cognia-next": patch
---

A paired browser no longer loses a conversation's transcript to its own boot. The transcript ownership negotiation was invalidated by every connection state change, including the `offline` to `reconnecting` to `connected` walk a companion transport makes on every page load, and it reported that as a failed history load. The chat pane then latched an error card over a conversation (an external agent's session included) whose messages were one round trip away, with nothing left to re-trigger the load. A negotiation that is overtaken now re-asks against the settled scope instead, keeps later callers on the same in-flight hydration, and reports failure only once the connection refuses to settle.

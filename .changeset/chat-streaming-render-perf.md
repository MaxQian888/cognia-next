---
"cognia-next": patch
---

Cut chat rendering cost for long conversations and multi-turn streaming: the chat pane chrome (composer, header, docks) no longer re-renders on every streamed token frame (run-record persistence now uses a transient store subscription); team-chat streaming gains the same rAF-coalesced store commits and debounced Dexie persists as direct chat (previously one full DB transaction + React commit per token batch); per-token Dexie reads were removed from the SDK event hot path; and the context-usage indicator, session cost badge, run-panel metrics, branch navigator, and timeline minimap now recompute their O(n) message aggregates only when a message lands or usage moves — not on every frame.

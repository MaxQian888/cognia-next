---
"cognia-next": patch
---

Chat: controls that only appeared on pointer hover are now reachable by keyboard and on touch. With message actions set to "hover" the action bar (copy, edit, retry, branch) was tied to hover alone, and the plugin message-action slot and plugin context menu were hover-only in every mode — so on iOS/Android none of them could be revealed, and keyboard focus landed on invisible controls. The per-file "discard" button in the workspace changes card was likewise invisible but still tappable on touch.

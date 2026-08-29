---
"cognia-next": patch
---

Typing in Canvas is no longer four operations per keystroke. Each character used to trigger a store write, a re-render of the whole panel, a synchronous full-state write to local storage, and a database transaction that re-saved every canvas document you have along with its entire version history. Edits now settle once per typing pause, only the document you touched is saved, and the split-view preview stops flashing a loading overlay on every character.

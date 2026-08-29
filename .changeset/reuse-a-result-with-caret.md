---
"cognia-next": minor
---

Reuse a result from another conversation with `@result:`, or with the new `^` shortcut.

Chat history has never been able to find what a turn _produced_. The search index deliberately drops tool outputs — a single file read is tens of KB, and indexing them would bury real prose — so "the thing that came out of the other chat" was the one thing you could not search for and could not reference.

A second, much leaner index now records one row per tool result: what ran, what it was about, how big the output is, and an excerpt. `@result:` searches it; `^` opens the same picker with nothing to type and offers the most recent results first. Picking one reads the full output back from the message it came from, so what gets sent is what the message says now, not what the index remembered.

Both indexes are filled by the one walk over message history that was already running at idle, so this costs no additional read. Result rows are dropped with their message, and a referenced result is wrapped as untrusted content — a tool output is by definition text this app did not write.

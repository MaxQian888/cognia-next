---
"cognia-next": patch
---

TUI: fix the streamed-text reveal on short turns, narrow-terminal pickers, and a leaked external agent process.

The paced "typing" reveal held only a character count, so a short reply following a long one inherited the previous turn's count and appeared whole instantly — it skipped the animation exactly where it was most visible. It is now keyed by turn, and restarts if the text stops extending what was already shown.

Overlay and recovery lists measured their viewport in items while their budget is in rows, so a wrapping label — a long tool name, an executable path, an install command — drew more rows than the terminal had and pushed the highlighted row off screen. They now measure wrapped rows.

Cancelling an external-agent connect (or switching backends twice quickly) could leave the spawned agent registered: the connect only _ignored_ a late result rather than cleaning it up, and nothing else held a handle to it. Connect, cancellation, retry and teardown now share one owner, and a process that finishes registering after a cancel is reclaimed.

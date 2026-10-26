---
"cognia-next": patch
---

Cancelling an Agent Team delegation now really stops it: an external agent (Claude Code, Codex, …) is stopped instead of left running, a twin delegation cancelled while it is still loading never starts, and a result that arrives after the cancel no longer marks the delegation completed or failed.

---
"cognia-next": patch
---

Fix the CLI's built-in shell hanging for 30 seconds and then failing: the standalone CLI now answers the sidecar's host requests (workspace ports resolve to none) and refuses unsupported ones immediately.

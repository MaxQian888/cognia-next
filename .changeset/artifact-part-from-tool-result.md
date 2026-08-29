---
"cognia-next": patch
---

Fix an artifact card rendering as "content cleared" when it came from a tool call. The card was built from the tool's input, which is read before the artifact exists, so it pointed at an id that was never written. It is now built from the tool's result.

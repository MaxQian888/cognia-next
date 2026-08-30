---
"cognia-next": minor
---

`/memory` can now be filtered by what a memory is about the project (state, constraint, decision, verified outcome, gotcha, or "about you"), by workspace, by branch, and by freshness. Opening a mined claim shows when it was observed as opposed to when Cognia learned it, when it was last verified, why its scope was narrowed, and whether it applies where you are standing right now, with "cannot tell" kept distinct from "does not apply". A claim that stopped being true can be marked out of date without archiving it, since expired history is still history.

Adds Settings, Memory, Project context: the two switches that decide whether Cognia learns from a workspace's own chats (on by default) and whether it tells the model what it learned (off by default). Until now the first of those had no off switch anywhere in the product.

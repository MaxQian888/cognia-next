---
"cognia-next": patch
---

The runtime a conversation runs on is now the conversation's own. Switching to an external agent in one chat used to retarget every other chat's next turn, including one that was already streaming, because the lane was a single app-wide value read at send time. Each conversation now keeps its own choice and new ones start from the app default, which is the same split Agent Modes already had.

Deleting or disabling an external agent also clears it from every conversation that had pinned it, not just from the app default, so a background or scheduled turn can no longer be handed an agent that no longer exists.

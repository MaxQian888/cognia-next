---
"cognia-next": minor
---

The workspace editor now follows the conversation it belongs to instead of opening on the workspace's main repository, so a conversation working in a managed worktree shows the files the agent is actually editing. The existing root switcher marks which entry means "follow" and doubles as the pin: picking another root holds the editor there, and the root chip in the toolbar names the directory, says when it is a worktree alias, and offers one click back to following. The toolbar no longer hides itself when there is only one root — that was exactly the case where nothing else told you which tree you were on.

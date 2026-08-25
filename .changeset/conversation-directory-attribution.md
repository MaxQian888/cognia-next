---
"cognia-next": patch
---

A conversation's tools now point where the conversation actually works. Five surfaces — an IM-resumed turn, "open this edit in review", the editor plugin tool, the artifact save dialog and the changes card — resolved the workspace's primary root instead of the conversation's execution root, so a conversation bound to a managed worktree ran and rendered against the checkout that worktree was cut from. "Open in review" was the worst of them: it silently did nothing for every agent edit made inside a worktree.

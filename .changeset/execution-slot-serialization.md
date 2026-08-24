---
"cognia-next": minor
---

Turns that share a working tree now run one at a time, while turns in different worktrees or sandboxes still run in parallel. The terminal and Source Control follow the conversation's execution root instead of the workspace root, so a conversation working in a managed worktree gets a shell and a diff in that worktree — and every panel says which folder it is pointing at.

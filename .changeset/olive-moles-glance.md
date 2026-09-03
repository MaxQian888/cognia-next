---
"cognia-next": minor
---

Source Control now knows which worktree holds each branch, so a branch row states where it lives and offers the action that fits. A branch another worktree has checked out opens that worktree instead of attempting a checkout git would refuse, a remote-only ref creates a local tracking branch instead of detaching HEAD, and delete is offered only where git would accept it. Rows also show the ahead and behind counts, the upstream, the stack parent, and a mark on branches an isolated agent run cut. Deleting an unmerged branch now asks whether to force it rather than failing with a toast. Fixes `git_worktree_list` returning a 500 on every paired client, and teaches the file watcher to notice worktrees being created, locked or pruned.

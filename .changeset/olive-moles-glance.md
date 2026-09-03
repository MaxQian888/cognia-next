---
"cognia-next": minor
---

Source Control now knows which worktree holds each branch, so a branch row states where it lives and offers the action that fits. A branch another worktree has checked out opens that worktree instead of attempting a checkout git would refuse, a remote-only ref creates a local tracking branch instead of detaching HEAD, and delete is offered only where git would accept it. Rows also show the ahead and behind counts, the upstream, the stack parent, and a mark on branches an isolated agent run cut. Deleting an unmerged branch now asks whether to force it rather than failing with a toast.

A new Browse view puts repository, worktrees, branches and stacks in one navigator, so the two most structural things in Source Control are no longer two clicks deep in an overflow menu. The phone gets the same two views instead of a link out to Workspace. Source Control is no longer duplicated as a Workspace tab, which now links to it, and old deep links redirect.

⌘K finds branches and worktrees, opening Source Control bound to the right repository without ever checking out.

On narrow screens the panel now sizes itself from its own pane rather than the window, the header no longer clips its buttons off the right edge, and the toolbar folds pull, push and fetch into its overflow menu. Sheets are the width they declare: blame and compare-refs had been rendering at 384px on desktop and overflowing a phone.

Also fixes `git_worktree_list` returning a 500 on every paired client, teaches the file watcher to notice worktrees being created, locked or pruned, and gives Squad rows in ⌘K their missing label.

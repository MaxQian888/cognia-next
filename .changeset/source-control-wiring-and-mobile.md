---
"cognia-next": minor
---

Source Control is more complete and more reliable on every screen size.

- The open diff now refreshes when an agent or the editor changes the file.
- Switching files never shows the previous file's diff.
- Every history, blame, remotes, tags, compare, rebase and restore view now says when it is loading, and shows the error with a Retry button when a read fails, instead of looking empty.
- Picking a commit in the Timeline now closes the sheet and opens the commit, with a "Back to changes" button.
- Both "Discard All Changes" actions now also delete untracked files, and the confirmation says so.
- Initialising a repository shows an error if it fails.
- On phones, Source Control now shows the merge/rebase Continue and Abort bar and a load error with Retry. Conflicted files open in the conflict resolver. There is a Publish button for branches without an upstream, pull follows the pull-rebase preference, buttons show when they are busy, and Sync, Timeline, Stashes and per-file history are available.
- Links from the project overview open the right repository and file.
- Panels switch with short animations (disabled for large change lists and under reduced motion), a loading skeleton, and a narrow-width layout for the commit and compare views.

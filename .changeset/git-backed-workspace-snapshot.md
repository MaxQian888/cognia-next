---
"cognia-next": minor
---

Starting a task in a Git workspace is dramatically faster. Acquiring a workspace used to read and hash every file in the checkout and copy all of it into the snapshot store, even though the checkout is a Git worktree and Git already held every byte. The snapshot is now taken from Git — the tree listing plus the handful of files that actually differ from the commit — and the bytes of unmodified files are read back out of the repository when something needs them. Measured on this repository (280 MB, 25,138 tracked files): 13.7s to 0.55s, and the snapshot copies 13.8 MB instead of 287.8 MB. Creating a managed worktree no longer empties the tree Git just checked out and rewrites it file by file; it applies only the difference.

Two consequences worth knowing: a tracked file that `.gitignore` also matches now appears in change records (it previously produced none, because the old scan judged files by ignore rules and never knew what was tracked), and each captured baseline pins its commit under `refs/cognia/workspace-base/` so a later `git gc` cannot collect content a pending rollback still needs.

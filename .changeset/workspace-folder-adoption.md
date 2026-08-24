---
"cognia-next": minor
---

The workspace switcher now offers to adopt folders the app is already working in — a worktree's source repository, a terminal tab's directory — when no workspace owns them. Adopting mounts the folder as a workspace without moving anything on disk, and only the repository is offered, never a derived checkout. Dismissals are remembered per device.

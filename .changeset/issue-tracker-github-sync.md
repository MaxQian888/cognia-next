---
"cognia-next": minor
---

Issue board: mirror GitHub issues onto `/issues`, and write back to them.

Bind a GitHub repository to a project from the project inspector and its issues
appear on the board as read-only federated rows. A background task refreshes the
mirror every 15 minutes (created when the first repo is bound, retired when the
last one is removed), and "Sync now" forces a full re-read. Commenting, labelling
and closing write back through the existing `github-delivery` integration, each
behind a confirmation dialog that names the account the write goes out on.

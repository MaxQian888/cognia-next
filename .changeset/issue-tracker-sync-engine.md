---
"cognia-next": minor
---

Issue tracker bidirectional sync engine. A `github-repo` binding can now be set to import mode, which turns every GitHub issue into a local issue linked through external references and keeps the two in step both ways with field-level last-writer-wins and recorded conflicts. GitHub milestones and Projects v2 iterations populate cycles, pull requests that name an issue become links on it, and local edits go back through the `updateIssue` action of the GitHub integration. The scheduled refresh covers every binding.

---
"cognia-next": patch
---

Fix the composer toolbar overlapping on narrow panes: the row now folds by a measured-width priority ladder (preset/sandbox/plugin slots first, then icon-only per-turn chips, then fusion + session cost into "⋯", and finally a ring-only context indicator) instead of letting `shrink-0` chips paint over the status cluster. The squad executor summary truncates inside a real flex box, and the session-cost badge's visibility is decided by pane width rather than a viewport media query.

---
"cognia-next": patch
---

Canvas AI reviews are harder to get wrong. The hunks you accept are now built by the same diff engine the review panel draws with, so on a block move the lines you accept are the lines you read. A proposal carries a fingerprint of the content it was diffed from, so one that no longer matches the buffer is refused and offers a rerun instead of applying its line numbers onto text that moved. An open review survives a reload instead of being thrown away. And an AI edit to a selection snapshots a version first, so it is recoverable from history as well as through undo.

---
"cognia-next": minor
---

Issue tracker: agents can now work the board, and it fits a narrow window.

The `issue.*` skill family grows from two tools to twelve, so an assistant can
read, edit, assign, label, comment on, run, cancel, re-home and delete issues
and their delivery containers instead of only filing one and losing sight of
it. Every write goes through the board's own guard, so an agent cannot move an
issue the runtime is executing or edit a row only GitHub owns, and writes are
attributed to the assistant rather than recorded as the user's.

`/issues` and `/projects` now share one navigation rail, and the three-pane
layout collapses to overlays below 1024px instead of starving its columns:
board columns, detail values and the projects table's issue count no longer
fall off the right edge of a narrow window.

Also fixes three ways tracker rows could be stranded: an issue whose workspace
disagreed with its container's, a move that created one, and deleting a
workspace, which left every container, issue, activity trail and run beneath it
orphaned.

---
"cognia-next": patch
---

Stop the composer's `@` panel and the command palette from re-reading whole tables on every keystroke, and stop `@chat:` offering conversations that are not conversations.

The `@memory:` / `@issue:` / `@chat:` / `@artifact:` panel read its entire store on each keystroke past the debounce — including every full session row — and rebuilt a lowercased haystack per row on top of it. Candidate lists are now cached per workspace and conversation and dropped when the panel opens, so the store is read once per picking session. The panel's own result object is memoized too; without that, the popover rebuilt its whole candidate list every frame and reset the keyboard highlight mid-typing.

`@chat:` also listed subagent inner transcripts, workbench asides and workflow-editor sessions, which are reachable from the turn that owns them and from nowhere else. It now applies the same exposure contract global search does, and takes a conversation's transcript snapshot by reading its tail instead of reading every message in it.

Two more reads on the same path: the command palette's cross-workspace session query no longer runs while the dialog is closed (it re-ran on every persisted streaming chunk), and a debounced search no longer takes a history-backfill step in front of the query — the idle scheduler still advances coverage.

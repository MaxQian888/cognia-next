---
"cognia-next": patch
---

Session import: "Live sync" now behaves the way its description promises. The
watch is owned for the app's lifetime and driven by a persisted preference, so
it keeps importing after the import dialog is closed and survives a restart —
previously closing the dialog dropped the event listener while leaving the
native filesystem watcher running with nobody listening, the switch always
re-read as off, and the choice never persisted. Switching workspace now
re-targets the running watch instead of continuing to file new sessions under
whichever workspace was active when it was turned on, and a background
re-import that fails is logged instead of surfacing as an unhandled rejection.

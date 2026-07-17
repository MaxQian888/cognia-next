---
"cognia-next": patch
---

Desktop: exit gracefully on Ctrl+C / SIGTERM

`pnpm tauri dev`'s Ctrl+C (and any `SIGINT`/`SIGTERM`, e.g. from OS logout or
`kill`) was hard-killing the process before Tauri's `RunEvent::ExitRequested`
teardown could run — because nothing in the app installed a signal handler, so
the kernel applied its default "terminate" disposition. That orphaned the
crash-monitor child and sidecars, leaked the CLI-bridge socket / cua sandboxes /
external-agent processes, and — since `crash::sentinel::mark_clean_exit()` never
fired — made the **next** launch mistake the clean shutdown for a crash and
raise the recovery dialog.

A new desktop-only `shutdown` module now hooks `SIGINT`/`SIGTERM` and routes the
first one through `AppHandle::exit(0)`, replaying the exact graceful teardown of
a normal quit. A second signal force-exits, so a wedged teardown can never trap
the user on the terminal.

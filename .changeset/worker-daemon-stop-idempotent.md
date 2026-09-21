---
"cognia-next": patch
---

cli: `worker daemon stop` is idempotent when nothing is running

Stopping a daemon whose recorded pid is already dead (or that was never
started) used to report `stopped:false` and exit 1, which read as a failure
even though the requested end state — no daemon running — already held (and
the stale pidfile was cleaned up). `StopDaemonResult` gains `notRunning`, and
the command now exits 0 for that no-op case, matching `systemctl stop` /
`docker stop` semantics.

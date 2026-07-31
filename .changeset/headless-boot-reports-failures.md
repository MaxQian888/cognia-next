---
"cognia-next": patch
---

`cognia-server` now reports why it could not start instead of aborting. Building the headless service container panicked outright on four ordinary environment problems — an unwritable data directory, a workflow database that would not open, a missing async runtime, and a provider profile store that failed even in memory. A permissions mistake or a full disk took the process down with a raw panic and a backtrace rather than the one-line "headless services: …" the rest of the boot sequence prints, which is the difference between fixing a deployment in a minute and reading a stack trace to find out which directory was at fault.

The last of those sat inside a path that already existed to _degrade_ gracefully: the profile store is a re-derivable projection, so an open failure is meant to fall back to an in-memory store and carry on. It aborted instead when the fallback itself failed.

Desktop is unaffected — it never constructed this container.

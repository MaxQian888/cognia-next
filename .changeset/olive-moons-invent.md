---
"cognia-next": patch
---

Fix `cognia-agent serve` aborting at boot. The headless Dexie shim points `window`
at the bare Node global, which has no `addEventListener`, and the resume-reconnect
watcher's `?.` only guarded against a missing object — not a present one lacking
the method. The watcher now feature-detects the method, and the connector runtime
bootstrap no longer turns a recoverable error into an unhandled rejection.

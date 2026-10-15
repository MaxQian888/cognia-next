---
"cognia-next": patch
---

An always-on host's device page now has a Runtimes section: it lists the host's background runtimes, leads with any that failed to start and why, and restarts one at a time without restarting the host (also available as `host_runtime_status` / `host_runtime_restart` through `cognia host call`).

---
"cognia-next": patch
---

Remote sandboxes no longer lose work when the push fails: the commits are saved as a git bundle on the host (or the sandbox is kept and the push retried until its deadline), a sandbox the provider refused to delete is retried instead of forgotten, and an always-on host reports runtimes that failed to start as degraded in `/healthz`, `/readyz` and `/metrics`.

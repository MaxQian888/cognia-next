---
"cognia-next": patch
---

Fix review findings across the recorder, provider diagnostics, editor and diagnostic service: the Windows password probe no longer reads a UI Automation error as "not a password"; provider diagnostics enforce the 50-request / USD 0.25 spend ceiling as a hard cap callers cannot raise; a preview tab evicted while its file was still loading no longer reappears; crash capabilities report Safe Mode as degraded instead of supported while its runtime is unwired; and the diagnostic service gains an intake kill switch, a migration switch so serving pods need no DDL grant, working SMTP alert egress, a Compose bring-up that seeds after migrating, and CI that builds, tests, publishes and smoke-tests it.

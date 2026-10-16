---
"cognia-next": patch
---

Fix native managed-desktop operator compilation and handle E2B's omitted default domain while retaining endpoint validation. Retry transient guest-startup upstream failures within the existing deadline without treating them as authentication evidence. Preserve readiness failure codes and add credential-free smoke diagnostics. Production remains dormant pending complete real-provider qualification.

Require a successful delete retry before provider expiry so native TTL cleanup cannot falsely qualify retry recovery.

Launch the desktop in its unprivileged home directory so E2B's default process working directory cannot break dependency startup.

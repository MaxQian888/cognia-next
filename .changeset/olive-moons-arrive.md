---
"cognia-next": minor
---

Admin escalations now need a real confirmation. `host_admin_lease_issue` used to take its interactive approval as an argument the caller set — and the only caller set it to `true` — so a paired device could mint a host-admin lease with nobody watching. The host now records the request, publishes it to whoever may answer, and consumes the answer once. A member device asking to read connector credentials waits for an administrator; the tenant's Owner device remains its own root, so a fresh deployment is not deadlocked on a second device that does not exist yet.

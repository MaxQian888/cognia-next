---
"cognia-next": minor
---

An always-on host run with Docker Compose now updates itself too: `compose.host-updates.yaml` adds an update agent that checks the signed release, swaps the server image by digest, and rolls back if the new version does not come up.

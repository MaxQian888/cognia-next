---
"cognia-next": patch
---

Agent Team runs interrupted by a restart are recovered by the team coordinator instead of being replayed (and failed) by workflow resume, the headless brain now recovers them too, and a workflow run that lost its lease to another device stops instead of overwriting that device's progress.

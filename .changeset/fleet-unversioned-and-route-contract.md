---
"cognia-next": patch
---

The OpenCode fleet plugin now calls unversioned command paths, matching every other route on that listener. An already-installed plugin is marked stale in Fleet settings so it can be reinstalled in one click. Until it is, its acknowledgements fail and commands are redelivered rather than lost. Seventeen routes that were live but declared nowhere are now part of the route contract, each with a written reason.

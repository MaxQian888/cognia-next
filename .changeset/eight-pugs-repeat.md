---
"cognia-next": patch
---

Fix desktop directory scanning finding nothing. Two filesystem permissions were never granted to the app, so listing a directory or testing whether one exists was rejected by the ACL, and every caller turned that rejection into an empty result. Scanning for installed coding agents found no sessions and no subagents, and Pi could not be detected as installed at all.

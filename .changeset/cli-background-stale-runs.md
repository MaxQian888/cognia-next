---
"cognia-next": patch
---

CLI: background sub-agent runs left `running` by a previous CLI process are marked interrupted again instead of breaking the journal, so collecting a finished run a second time returns its result.

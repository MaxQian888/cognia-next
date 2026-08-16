---
"cognia-next": patch
---

Connects the Code tool presentation end to end. The mode a session selects now rides to the agent runtime with the turn, so the runtime offers the tool surface that was actually chosen instead of always offering the default one, and the generated read-only SDK is described from the tools' real signatures rather than a hand-maintained copy. Whether Code can be offered at all is now decided by actually exercising the sandbox and observing that it holds — a sandbox backend that is installed but broken no longer counts as available — and the desktop app hands the agent runtime a real OS confinement wrapper to run programs through, reusing the same sandbox backend as the confined terminal. On a machine with no sandbox backend, Code stays hidden and its executor is never registered; nothing falls back to running unconfined.

---
"cognia-next": minor
---

Agent modes are now a composition of independent axes instead of one flat list. Session settings gain a preset picker (Standard, Minimal, Code, Creator, plus the existing domain modes) with an Advanced panel that sets permission, tool presentation, and orchestration separately, and a summary showing what the next turn will actually run as — including when a choice was narrowed by the preset's own cap or by a parent agent. The selection now belongs to the session: changing the mode in one conversation no longer silently retargets the others. Existing `agentModeId` values keep working — `plan`, `build`, and `workflow` map onto axis values, and an unrecognised mode falls back to Standard with default permission rather than inheriting an elevated one.

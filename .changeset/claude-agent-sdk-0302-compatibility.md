---
"cognia-next": patch
---

Upgrade Claude Agent SDK to 0.3.302 with portable runtime capabilities for trusted extension loading, per-tool ask/deny policies, subagent context inheritance and compaction windows. Keep manual permission and isolated subagent defaults. Preserve canonical background tool results, subagent parent/run identities, quota and timing metadata, and ordered structured elicitation. Unsupported features fail before execution. Provider compatibility certifications must be regenerated for the new SDK and bundled Claude Code versions.

Intersect runtime support with frozen session capabilities, reject unsupported raw external and standalone browser requests, and refuse feature overrides on content-only follow-ups. Revalidate extensions through legacy reload controls, preserve replacement sessions after stale reload failures, and allow saved extensions to be removed after switching to an unsupported runtime.

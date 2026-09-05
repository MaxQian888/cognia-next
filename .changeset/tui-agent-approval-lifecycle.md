---
"cognia-next": patch
---

Keep external-agent approvals bound to their active turn, pause idle timeouts while hosted-tool approval is pending, and preserve hosted tool events in the canonical event stream. Correct Pi dialog responses and cancellation so a negative confirmation or a late reply cannot approve work. Preserve transcript arrival order across concurrent tools, reasoning, and notices, and show pending approvals as waiting rather than executing.

Bundle webclone's Babel dependencies consistently across builders, prevent the imported OAuth helper from consuming sidecar IPC, resolve the staged LSP host, and ship the Claude SDK's required platform runtime. Include bounded, redacted startup stderr in sidecar failures.

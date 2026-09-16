---
"cognia-next": patch
---

`/clear` (and its `/new` alias) in the CLI TUI now starts a fresh session immediately instead of opening a confirmation overlay first. The action was never destructive — every turn's transcript is appended to `~/.cognia/sessions/<id>.jsonl` as it runs, so the cleared session stays listed under `/sessions` and resumable via `/resume` — which matches how Claude Code, Codex, and Gemini treat `/clear`. The overlay's "It can't be undone" copy was inaccurate. Truly destructive flows (bypass-mode acknowledgement, plugin install, MCP apply/remove, commit apply, etc.) keep their confirmations.

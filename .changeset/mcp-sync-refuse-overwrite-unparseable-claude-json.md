---
"cognia-next": patch
---

Stop MCP-server sync from wiping an unparseable `~/.claude.json`. When Claude Code's config file exists but can't be parsed (a hand-edit typo, trailing comma, or a write from another tool), cognia now refuses to overwrite it and surfaces a clear error instead of silently collapsing it to just `{ mcpServers }` — which previously dropped installed plugins, marketplaces, per-project settings, and auth. Fix the file (a `.bak` copy is also left by any prior write) and re-sync.

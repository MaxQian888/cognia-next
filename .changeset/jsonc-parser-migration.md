---
"cognia-next": patch
---

JSONC import paths (VS Code themes, MCP server configs, plugin snippets, icon themes, grammars, language configurations, code-server settings) now parse through `jsonc-parser` instead of hand-rolled comment strippers, so string values containing `,}` or `,]` are no longer silently rewritten on import.

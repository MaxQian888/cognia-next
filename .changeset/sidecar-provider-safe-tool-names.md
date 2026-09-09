---
"cognia-next": patch
---

Non-Anthropic providers no longer reject a turn because a plugin or MCP tool name contains a dot or slash (for example `ocr.extract`). The sidecar renames such tools to a provider-safe form on the wire and maps them back for the renderer, permission rules and ToolSearch, so the cognia name stays visible everywhere else.

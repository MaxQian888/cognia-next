---
"cognia-next": patch
---

Fix stdio MCP servers in the CLI agent: their tools now reach the model instead of failing with "The argument 'stdio' is invalid", and the server's stderr still reaches the MCP log.

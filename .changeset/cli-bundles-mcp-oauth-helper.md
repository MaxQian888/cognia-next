---
"cognia-next": patch
---

Fix remote MCP sign-in on `cognia-agent` and `cognia-server` hosts: the MCP OAuth helper was copied into the CLI layout as a raw script whose MCP SDK import had nothing to resolve against there. The layout now ships it as a self-contained bundle, like the MCP stdio relay.

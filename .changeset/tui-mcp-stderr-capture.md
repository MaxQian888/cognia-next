---
"cognia-next": patch
---

CLI TUI: MCP servers no longer smear the terminal. The Model Context Protocol stdio transport was spawning each server with its stderr inherited straight to our stdout — the SDK's default — so a server's startup banner, warnings, or crash trace printed over the interactive Ink frame. The shared transport (`lib/mcp/transport`, used by `/mcp` discovery, the workflow runtime, and the plan dispatcher) now pipes the child's stderr and drains it away from the screen. Captured stderr is also put to use: a failed `/mcp` probe now appends the server's stderr tail to its error, so a connection that dies (missing API key, `ModuleNotFoundError`, "command not found") explains itself instead of showing only a bare timeout.

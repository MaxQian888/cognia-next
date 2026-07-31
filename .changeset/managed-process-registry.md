---
"cognia-next": minor
---

Manage cognia-spawned processes from the performance panel. A new **Managed Processes** tab lists every child process cognia starts — external agents, the chat sidecar, ACP + integrated terminals, and the MCP server — grouped by subsystem, with live CPU/memory (joined by PID) and one-click kill (plus restart for external agents). A unified process-registry aggregator also closes the graceful-shutdown gap for the chat sidecar, integrated terminals, and MCP server, and the external-agent manager now reconciles a dead process back to `disconnected` instead of showing it as connected until the next health check.

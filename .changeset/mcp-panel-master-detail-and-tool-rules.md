---
"cognia-next": minor
---

MCP settings rebuild. The panel now fills the settings pane instead of guessing a viewport height inside a width-capped scroll area, and switching tabs no longer makes the page jump (both tab panels used to be laid out at once during the crossfade). "My Servers" becomes a master-detail pane: a dense server rail beside a detail half carrying per-tool switches, agent projection, OAuth state, the connection shape with copy-as-JSON / copy-as-command, and recent log lines.

Individual MCP tools can now be turned off — by exact name, or with a rule like `write_*` that keeps covering tools the server adds later. Turning a tool off no longer disables the whole server for re-review; only relaxing a rule or changing the command/endpoint does.

Adding a server no longer means retyping a README: paste a `claude mcp add …` / `codex mcp add …` line, a bare `npx …` command, or an `mcpServers` JSON block and it is parsed into a reviewable list. The reverse direction exports any server as JSON or an install command for another agent, with stored credentials emitted as references rather than secrets.

On a paired phone or web client, `/me/mcp` can now switch a server or an individual tool off through the offline-capable outbound queue; creating, editing and authenticating a server remain desktop-only.

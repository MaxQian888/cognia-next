---
"cognia-next": minor
---

Manage the Pi coding agent's packages from /plugins, and import the rest of its
configuration. New "Agent packages" section shows what each installed package
costs on every turn, which packages are competing for the same job (Pi itself
never warns), and a reviewed catalog with three one-click stacks. Pi's settings,
prompt templates, subagents and memory files now import like any other vendor,
`PI_CODING_AGENT_DIR` is honoured everywhere, and MCP works through the
third-party pi-mcp-adapter package. The plugin dependency view is now a real
graph instead of four flat lists.

---
"cognia-next": minor
---

Add `cognia plugin import`: convert an existing MCP server, agent skill, or CLI binary into a plugin project. Nothing from the source is executed and no credential or machine-specific path is ever copied — they become user-filled preset fields. Also fixes plugin-contributed skills whose `source.path` was relative: the host now anchors it against the plugin's install directory instead of the process working directory.

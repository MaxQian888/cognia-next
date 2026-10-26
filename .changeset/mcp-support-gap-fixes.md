---
"cognia-next": patch
---

Fix MCP support gaps: workflow, plan, MCP App and MCP-over-ACP calls now honor saved tool deny rules and stop using a server the moment it is disabled, blocked, edited or deleted; external ACP agents get only trusted, workspace-enabled servers with their credentials resolved, and refuse servers whose tool restrictions they cannot enforce; settings discovery accepts tools-, resources- or prompts-only servers, reads every page, and keeps MCP App metadata; a custom mode's MCP tool selection now limits the run, including tools a server adds later; and the External Bridge sends each response only to the request that asked for it and rejects an unnegotiated protocol version.

---
"cognia-next": minor
---

External agent backends now receive your MCP servers, and resuming a session actually resumes it.

`context.custom.mcpServers` was a hardcoded empty array, so a server you enabled in `/mcp` reached the built-in agent and nothing else — while the panel kept showing it as on. The CLI's resolved set (`.mcp.json` from the working directory and home, minus the `/mcp` disable overlay) is now handed to the agent's session, projected through the same mapping the desktop uses, and re-resolved after a `/mcp` toggle so the change lands on the next message rather than requiring a restart. Servers an external process could not dial — a stdio entry with no command, an in-process transport — are dropped instead of being shipped malformed.

On Codex, the thinking level and your configured skill directories now reach the agent through its own metadata channel: the level maps to a reasoning effort, and the directories are registered as extra skill roots so Codex discovers those `SKILL.md` files itself rather than having their contents pasted into a prompt. Both are read when the agent starts, so changing them takes effect on the next `/backend` reconnect. ACP agents have no counterpart for either, and are reported as unsupported rather than silently ignoring the setting.

`--continue` / `--resume` used to reload the full transcript onto an agent that had never seen a word of it, because the external session id was never recorded. It is now stored beside the transcript and handed back on resume, so an agent that supports session loading continues where it left off. When it cannot — no recorded session, an agent without the capability, or a transcript recorded on a different backend — the resume says so in a permanent line instead of quietly starting over. `/compact` likewise now refuses on backends that have no compaction rather than waiting forever on a message only the built-in agent answers.

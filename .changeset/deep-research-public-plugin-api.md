---
"cognia-next": minor
---

Deep Research now runs entirely on the public plugin SDK: `/research` answers with its full cited report in the chat instead of a toast, and search and page reads go through the app's configured search providers, result cache, source verification and SSRF guard rather than the plugin's own Exa/Tavily keys. Plugins can now call `web_search` / `web_fetch` via `ctx.agent.invokeTool`, slash commands can return their own chat message, and model calls route to the session that made them.

---
"cognia-next": patch
---

Claude Code now works through the Cognia gateway against OpenAI-compatible models. The gateway used to refuse two parts of Claude Code's requests on those models: its system-role context messages and its adaptive thinking setting. Those messages now join the system prompt, and adaptive thinking follows the requested reasoning effort. Fixed thinking budgets are still refused. Claude Code agent tasks also no longer add the commit attribution that the gateway's privacy check blocked.

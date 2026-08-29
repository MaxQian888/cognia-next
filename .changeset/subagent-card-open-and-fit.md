---
"cognia-next": patch
---

Chat: the "Open in workspace" link on a sub-agent card now goes somewhere. It pointed at `/agent-teams?focus=subagent:<id>`, a query param that page never read, so the link on every sub-agent card in every transcript just dropped you on the team list with nothing selected. It now opens the run in Agent Runs on the execution run id — the same destination the Job Center already uses, and one that survives a reload because it reads the run journal rather than the in-memory registry. The card also fits a narrow column now: the sub-agent name truncates instead of holding its full width, and the log preview, token count and tool count step aside in priority order rather than pushing the status glyph and the Stop button out of the row.

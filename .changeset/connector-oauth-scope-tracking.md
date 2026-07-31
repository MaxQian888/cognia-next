---
"cognia-next": patch
---

Platform connectors (Slack, Lark) now record the OAuth scopes granted at connect time, and a re-authorization whose scope set differs from the prior grant writes an "OAuth scopes changed" entry to the connector audit log — so a silent scope escalation on reconnect is visible after the fact.

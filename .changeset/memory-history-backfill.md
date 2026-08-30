---
"cognia-next": minor
---

Adds an explicit history backfill for project context: a one-time sweep that mines every earlier conversation in a workspace, so a project with a year of chat behind it does not start empty. The sweep never starts on its own. It first estimates the work from index counts alone, without reading a single message body, shows what that would cost, and waits for you to agree. It can be paused, resumed, and stopped, and stopping withdraws the work it has not done yet. Progress is reported against conversations checked rather than facts found, so an unproductive stretch of history still moves the bar.

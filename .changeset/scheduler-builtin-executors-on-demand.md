---
"cognia-next": patch
---

Scheduled chat, agent, skill, backup, workflow and other built-in tasks no longer fail with "No executor registered for task type" when a plugin started the scheduler before the app finished starting it. This included the plugin's own scheduled task. It happened when the automation part of startup never loaded or loaded more than a minute later, for example in development or in `cognia-agent run --plugin-tools`. The scheduler now loads the built-in executors itself when one of their tasks comes due.

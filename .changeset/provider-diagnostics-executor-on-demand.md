---
"cognia-next": patch
---

The built-in "Provider diagnostics refresh" schedule no longer fails every five minutes with "No executor registered for task type: provider-diagnostics-refresh". This happened when the scheduler was started before its own startup finished, for example by a plugin creating a task, which was common on the web shell. The scheduler now loads the diagnostics executor itself when the task comes due, so the task runs on every host that lists it as Active.

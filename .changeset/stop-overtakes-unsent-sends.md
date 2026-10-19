---
"cognia-next": patch
---

Stop on a paired client now reaches the running turn ahead of sends still waiting in the outbox, and those unsent messages go back to the message box instead of starting new turns after the stop.

---
"cognia-next": minor
---

Issue wakeups can have a deadline (1 hour to 2 weeks) and, when it passes before what they wait for, either stop or wake the issue once more to say the wait ran out. Event-triggered scheduled tasks now actually expire at their end date instead of firing past it.

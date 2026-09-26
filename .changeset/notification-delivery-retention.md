---
"cognia-next": patch
---

Notification delivery history no longer grows forever. Once a message sent to a chat or webhook has settled and is older than your notification "Keep for" window (30 days by default), its text and the chat it went to are dropped. Only the record that it was sent (when, where, and the outcome) is kept, so an old notification can never be sent twice. Deliveries whose outcome is unknown are kept whole until resolved. Old send attempts, finished timers and sent digest entries are removed at the same time. The notification settings on desktop and phone now say that "Keep for" covers this too.

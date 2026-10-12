---
"cognia-next": patch
---

Integration webhooks are no longer lost when a consumer fails: a workflow trigger, Bot, inbox thread or issue-board refresh that throws after the event is stored is now retried in the background (and after a restart) instead of being dropped on redelivery, and a webhook that waited out a retry is picked up without needing a new one to arrive.

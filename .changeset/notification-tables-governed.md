---
"cognia-next": patch
---

Notification delivery data is now encrypted on disk like the rest of your account's content: the rendered text queued to go to a chat or webhook, the chat each delivery target points at, and the run result summaries notifications quote. Rows already written stay readable and are encrypted the next time they're saved. None of the notification delivery data is copied to paired devices or into portable backups.

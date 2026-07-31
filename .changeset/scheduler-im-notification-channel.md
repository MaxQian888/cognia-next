---
"cognia-next": minor
---

Scheduled tasks can now send their notifications to an IM conversation. Pick the new **IM** channel on a task and name the conversation, or leave it blank to use a global ops channel configured once in settings. Previously a task result could only reach chat by hand-authoring a separate connector task, even though the notification center already had an IM delivery channel — the scheduler just never offered it. The per-conversation proactive-push opt-in still applies, so a conversation that has not enabled it receives nothing.

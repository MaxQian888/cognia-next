---
"cognia-next": minor
---

Inbox delegation: assigning a conversation now syncs routing (character/team assignments take over replies, "Me" switches to manual mode, unassign restores the previous routing) with an "assignment" source label in /status and the override editor, plus a Notification Center notice per assignment change; new SLA escalation engine — bot-wide default SLA minutes + multi-step escalation chains (notify / reassign / switch mode / Lark urgent) editable per bot and per conversation, run by the connector runtime host and audited as `sla.escalated`.

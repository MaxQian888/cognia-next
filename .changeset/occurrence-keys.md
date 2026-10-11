---
"cognia-next": minor
---

Workflow runs are now keyed on the event that started them, not on the second it arrived in. Two webhooks, two connector messages or two integration events in the same second used to collapse into one run; now they start two. A webhook trigger can name the header that carries the sender's delivery id (for example `X-GitHub-Delivery`; `Idempotency-Key` by default), so a retried delivery does not start a second run. Connector messages are keyed on the platform's own message id. Scheduled runs keep the identity of their slot even when they fire late: a cron trigger, a scheduled task, a Bot's timed trigger and a wake from the system scheduler all report the slot they were for. A slot reached twice on the same machine runs once.

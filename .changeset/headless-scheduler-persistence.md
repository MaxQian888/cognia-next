---
"cognia-next": patch
---

Scheduled tasks now survive a restart on a headless host. The brain's snapshot only covered `CogniaDB`, so the scheduler's separate `CogniaSchedulerDB` was never persisted — a restarted `cognia serve` came back with an empty schedule while still reporting the scheduler as running. Execution history is deliberately still not persisted there (failures remain durable in the connector audit trail and the Notification Center).

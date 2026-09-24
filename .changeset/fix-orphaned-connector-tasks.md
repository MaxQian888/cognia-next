---
"cognia-next": patch
---

Fix orphaned `connection:*` scheduled tasks retrying into `EXECUTOR_NOT_FOUND` forever after their connector adapter is removed: adapter deletion now reaps the bound schedules, a scheduler-boot sweep deletes orphans created before the cascade, and the usage-presence executor retires its own schedule when the adapter row is gone.

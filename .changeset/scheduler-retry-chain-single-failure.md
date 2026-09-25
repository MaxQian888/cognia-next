---
"cognia-next": patch
---

A scheduled task whose run reports a failure (rather than crashing) no longer counts every retry attempt toward "pause after N consecutive failures". A whole retry chain now counts as one failure, as it already did for crashed runs, so a task set to retry is no longer auto-paused partway through its retries, and the task only shows the failure reason once its retries run out.

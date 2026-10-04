---
"cognia-next": minor
---

Scheduler plugin API: `ctx.scheduler.runTaskNow` returns the real execution id and passes its arguments to the handler, `cancelExecution` actually stops the run, plugin-created tasks go through the scheduler permission policy and quota, task and execution statuses are reported correctly, and handler log lines appear in the execution history. New `onExecution`, `emitEvent`, `getStatistics` and `previewTrigger`, plus the full execution options (overlap policy, max runs, auto-pause, end date, jitter, catch-up). `ctx.userScheduler` can no longer attribute a write to the user, checks the policy on every write, and gains `getTask`, `updateTask`, `pauseTask`, `resumeTask`, `listExecutions`, `getExecution`, `cancelExecution` and `getUpcoming`, including for Python plugins.

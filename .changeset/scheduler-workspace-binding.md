---
"cognia-next": minor
---

A scheduled task's workspace can now be seen and changed. It was decided once when the task was created and was not writable afterwards, so a schedule filed under the wrong workspace was invisible from every other one and uncorrectable from the one that owned it. Separately, both scheduler views scoped their list by this device's active workspace even when showing a paired host's schedules, which silently hid every attributed task on that host.

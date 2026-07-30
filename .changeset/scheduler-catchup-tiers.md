---
"cognia-next": patch
---

A scheduled task missed while the host was offline is now handled according to what the task does, instead of always being dropped. Presence refreshes still skip (the next tick is authoritative), chat/agent/digest tasks deliver once if they are still within a 15-minute grace window, and backup/wiki/radar/twin tasks replay the slots they missed. Deliveries that fired from a missed slot are labelled as delayed in chat, naming the time they were scheduled for, so a late digest is not mistaken for a current one. An explicit per-task config still overrides all of this.

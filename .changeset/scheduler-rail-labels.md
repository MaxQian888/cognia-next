---
"cognia-next": patch
---

Scheduler: a paused task's row now says "Paused" instead of "Every 7d · No schedule", event-driven items say "On Event", and built-in event triggers read as their names ("Backup completed") rather than internal ids. The "Paused" filter no longer truncates to "Paus…", and the Next 14 days strip shades days against the busiest one instead of turning every day into a solid black bar for frequent tasks.

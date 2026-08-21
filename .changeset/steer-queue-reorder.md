---
"cognia-next": minor
---

Queued follow-ups ("steer" messages typed while a turn is running) get a real queue editor in the run panel: the pending-count chip now opens a Queued section listing every undelivered message in the order it will actually be sent, with drag-to-reorder (a @dnd-kit vertical sortable with a per-row grip, keyboard reordering, and localized screen-reader announcements), a multi-line rewrite, removal, an attachment count, and a jump back to its bubble in the transcript. Because the whole queue drains as one framed turn, its order is what the model reads — so each still-pending bubble also shows its position (2/3) once more than one is queued, and editing a follow-up from the bubble no longer collapses a multi-line message onto one line.

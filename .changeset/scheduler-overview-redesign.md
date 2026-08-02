---
"cognia-next": minor
---

Rebuild the scheduler overview as a flat, hairline-separated page instead of a stack of cards: one summary band with proportional task-composition and success-rate meters, a kind rail, and flattened monitor / chart / upcoming / recent sections. The calendar day panel and the timeline now share one list that collapses a task's repeated runs into a single row with its fire times, and long execution errors expand into a bounded, scrollable block (with stack traces behind a disclosure in the run sheet) rather than stretching the layout. Also adds the missing `scheduler` translations that made task detail throw `MISSING_MESSAGE` (six task types plus `timeout`, `tags`, `systemDefault`).

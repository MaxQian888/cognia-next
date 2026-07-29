---
"cognia-next": patch
---

Fix the goal history table not updating after you delete a goal. The list is a live query, but the delete happened outside anything it was watching, so the row stayed on screen — and deleting the last goal left the table showing a goal that no longer existed instead of the empty state. Deleting now re-reads the list, so the row disappears when you delete it and the empty state appears when the last one is gone.

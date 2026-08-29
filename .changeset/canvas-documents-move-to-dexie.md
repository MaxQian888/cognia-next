---
"cognia-next": patch
---

Canvas documents are stored in IndexedDB instead of a localStorage blob, and moving the cursor through a large document no longer re-saves every canvas document you have. The blob was rewritten in full on every state change, and the cursor position is part of that state. The move also fixes a quieter bug: which artifact a canvas document was opened from — and therefore the way back to it — was never mirrored out of localStorage, so it is now kept along with the document's prompt draft and action history.

---
"cognia-next": minor
---

Closing a Canvas tab no longer deletes the document. The tab strip now tracks which documents are open, so the X takes a document out of the strip and leaves it in the workspace. Deleting is a separate, confirmed action that says what goes with the document (its comments, and how many saved versions), and it now also releases the pin, the tab and the in-memory comment threads that used to outlive it.

---
"cognia-next": patch
---

The side chat no longer flickers. Every dock panel was being torn down and rebuilt whenever the conversation record was re-read, and the side chat re-read it as it mounted, so it flashed between its empty state and the chat several times a second and a new aside never kept its composer. Panels in the dock now update in place, so the embedded browser also keeps its page and the workspace keeps its open files while a conversation streams or an artifact is saved.

---
"cognia-next": patch
---

Canvas comments now follow the text they were written about. A comment made while a shared document is open records a Yjs relative position alongside its offsets, so an edit anywhere above it moves the comment instead of greying it out. Previously any change to the document bumped its revision and marked every comment on it stale, whether or not the edit had anything to do with them. The stored offsets are kept and still used by any device that cannot resolve an anchor, and a comment whose text is actually deleted reports itself stale rather than silently re-pointing at whatever moved into its place.

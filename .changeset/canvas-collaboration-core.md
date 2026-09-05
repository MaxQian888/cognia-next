---
"cognia-next": minor
---

Canvas collaboration now uses a real CRDT. The old one was positional with no transform at all: two people inserting at the same place each applied the other's raw character index into their own already-changed text, so the documents silently diverged, and any update the causal gate could not order was dropped forever with no buffer and no retry. Yjs replaces those internals behind the same hooks and components.

Share links carry three identifiers and nothing else. They used to carry the whole session as JSON (the owner, the participant list, the permission flags, the document content and its entire operation log) plus an arbitrary `?server=` URL that the join page wrote into your saved settings with collaboration switched on and no validation of any kind. Opening a link now resolves the document against your own workspace and says plainly when it cannot: an old link is reported as expired rather than as a decode failure, and the page no longer claims success without opening anything.

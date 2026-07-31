---
"cognia-next": patch
---

Fix a dead-end in the Source Control panel on paired web/mobile clients: the StatusBar branch chip could appear and link to a Source Control panel that only rendered on the desktop, leaving a live button pointing at an empty "desktop only" page. The panel and the branch chip now share a single availability gate, so Source Control is consistently desktop-only for now and no clickable branch chip can navigate to a dead panel. (The underlying transport seam still supports more targets; surfacing the panel on a companion or mobile client is tracked as a separate follow-up.)

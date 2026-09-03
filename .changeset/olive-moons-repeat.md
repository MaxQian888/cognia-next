---
"cognia-next": patch
---

A conversation whose page reloaded mid-turn can be sent to again. The turn it left running kept holding that conversation's working copy, and because nothing ever ended it, every later message was refused with "pipeline workspace is already active" until the app itself was restarted. A refused send now asks the browser's other tabs whether any of them is still driving that turn, and releases it only when none is.

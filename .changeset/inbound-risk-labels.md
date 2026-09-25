---
"cognia-next": minor
---

Plugins can now label an inbound IM message instead of only blocking it: an `onConnectorInbound` hook may return `{ action: "annotate", labels }`, the host validates and caps the labels, stores them on the message, clears them if the platform edits it, and shows them as chips in the transcript. The Laya plugin's observe mode uses this, so a message it would have dropped now shows its spam / toxic / harassment / threat score instead of only bumping a hidden counter.

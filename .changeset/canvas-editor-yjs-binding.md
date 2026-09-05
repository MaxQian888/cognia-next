---
"cognia-next": minor
---

Canvas editors are now bound to the shared document. Monaco and CodeMirror write into the CRDT directly, and one document-level update bus broadcasts every change this device makes, so an AI apply, a model-tool write and a plugin write travel the same way as a keystroke without knowing collaboration exists. Before this the CRDT could receive and never send: the only producer of an outgoing operation had no callers. Remote cursors and selections are drawn from awareness, and four collaboration settings gained real readers (`showCursors`, `showSelections`, `cursorSmoothing` as the presence stylesheet, `presenceTimeout` as the awareness idle cutoff, `showAvatars` in the participant list). Two were removed rather than left inert: `serverUrl`, which named a signalling server nothing read, and `syncInterval`, which described a polling cadence this system does not have.

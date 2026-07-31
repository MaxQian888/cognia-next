---
"cognia-next": patch
---

Fix a runtime crash (`undefined is not an object (evaluating 'listeners[eventId].handlerId')`) thrown by the computer-use kill-switch initializer when it unsubscribes from the `automation:kill-switch` Tauri event. Under React StrictMode's mount→unmount→mount cycle the raw Tauri unlisten could reject before its registration eval had run; the initializer now routes both the early-cancel and unmount teardown through `safeUnlisten`, so the harmless already-gone case is swallowed instead of crashing the React tree.

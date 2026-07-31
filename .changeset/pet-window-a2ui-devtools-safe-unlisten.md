---
"cognia-next": patch
---

Fix a runtime crash (`undefined is not an object (evaluating 'listeners[eventId].handlerId')`) thrown when the desktop pet, the A2UI dispatch bridge, or the plugin devtools unsubscribe from their Tauri event channels. Under React StrictMode's mount→unmount→mount cycle the raw Tauri unlisten can reject before its registration eval has run, and because each call site invoked it as a floating promise the rejection escaped the surrounding `.catch`/`try` and surfaced as an unhandled rejection that spammed the error log and could crash the React tree. All four teardowns — `lib/tauri/pet-window.ts` (covering every `pet://` subscription: state-changed, suspend, resume, work-area-changed, and popup hidden), the `A2UIDispatchProvider`, the plugin hot-reloader, and the plugin dev server — now route through `safeUnlisten`, so the harmless already-gone case is swallowed.

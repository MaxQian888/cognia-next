---
"cognia-next": patch
---

Fix the browser-detection paths that Node 26 broke. Node 26 ships a global
`navigator` with no `onLine`, so `typeof navigator !== "undefined"` stopped
meaning "in a browser": the connector resume-reconnect watcher, the Capacitor
network fallback and the remote log transport all read `!undefined` and declared
themselves permanently offline in CLI, sidecar and headless runs. They now
require the flag to actually be a boolean.

Persisted zustand stores no longer crash off-browser either. They relied on a
bare `localStorage` reference throwing so zustand would disable persistence;
Node 26 declares `localStorage` as a real global that evaluates to `undefined`,
so the first write died with `Cannot read properties of undefined (reading
'setItem')`. Every persisted store now resolves its storage through the shared
`stores/persist-storage` helper, which falls back to inert storage — including
the ones that named no `storage` at all and so inherited zustand's own
`localStorage` default, which fails the same way.

---
"cognia-next": minor
---

Rework the built-in Context Inspector plugin panel into a token-driven surface that exercises the full mirrored context-panel API. The webview now styles itself with the host-injected design tokens and `@cognia/plugin-ui` motion constants (mirroring the Button/Badge/Card recipes instead of hard-coded colors), persists its counters through `acquireCogniaWebviewApi().setState` so they survive iframe remounts, surfaces the `ownsActivePanel`/`userPinned` gates instead of letting `setMode`/`setPinned` fail silently, adds controls for every workbench and reveal mode, and demos `register()`/`dispose()` by mounting a second declared webview (`inspector-probe`) as a dynamic panel — with a visible banner when the mirrored API isn't injected and a bounded action log.

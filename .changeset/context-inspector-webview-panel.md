---
"cognia-next": minor
---

Rework the built-in Context Inspector plugin panel into a token-driven surface that exercises the full mirrored context-panel API. The webview now styles itself with the host-injected design tokens and `@cognia/plugin-ui` motion constants (mirroring the Button/Badge/Card recipes instead of hard-coded colors), persists its counters through `acquireCogniaWebviewApi().setState` so they survive iframe remounts, surfaces the `ownsActivePanel`/`userPinned` gates and the workbench split layout instead of letting `setMode`/`setPinned` fail silently, adds controls for every workbench and reveal mode, and demos `register()`/`dispose()` by mounting a second declared webview (`inspector-probe`) as a dynamic panel — which can then be revealed cross-frame and badge/reveal itself. In-flight `register`/`dispose` calls disable their buttons until the RPC settles, the missing-API path shows a visible banner, and the action log is bounded and `aria-live`.

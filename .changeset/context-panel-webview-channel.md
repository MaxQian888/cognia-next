---
"cognia-next": minor
---

Context Workbench plugin panels gain a sandboxed webview rendering channel: `contextPanels[].webview` references a declared manifest webview, the full panel API is mirrored into the iframe via `acquireCogniaContextPanelApi()` (with pushed activeContext/workbenchState/visibility events), a new `onDidChangeVisibility` host API lets panels pause work while hidden, webview `setState` is now stored host-side and replayed into remounted frames, and the new built-in Context Inspector plugin ships as the declarative reference consumer.

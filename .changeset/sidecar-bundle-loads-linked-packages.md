---
"cognia-next": patch
---

Fix the packaged desktop app's agent sidecar dying at startup: the bundle copied the linked `@cognia/redact` and `@cognia/agent-config-types` TypeScript sources under `node_modules`, where Node refuses to strip types, and it never shipped the `unbash` shell parser. The sidecar now loads compiled builds of those packages and declares `unbash` itself.

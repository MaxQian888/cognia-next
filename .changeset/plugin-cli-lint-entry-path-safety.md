---
"cognia-next": patch
---

`cognia plugin lint` now rejects unsafe `entry` paths in the lazy-factory contribution fields (`ocrProviders`, `workspaceBackends`, `messageRenderers`, `aiProviders`, `modalMounts`, `routingStrategies`, `chatMiddlewares`) — path traversal (`..`), absolute paths / drive letters, and NUL bytes — using the same `manifest.<field>.entry.{traversal,absolute,invalid_chars}` codes the app's validator emits. Previously such manifests linted clean and exit 0, only to be rejected when the app loaded them; authors now get the same verdict locally.

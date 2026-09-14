---
"cognia-next": minor
---

E2B Sandbox plugin overhaul: the API key now lives in the OS keyring via `ctx.secrets` (a plaintext `apiKey` left in plugin settings is migrated once and the field cleared), the config schema gains the `domain` override it already honored, and the manifest declares the real capabilities/permissions (`workspace-backend`, `context-panel`, `secrets:*`, `extension:ui`, `session:read`) with `mcpServerPresets` materialized into plugin.json. `/sandbox` now answers with a localized markdown status report instead of a toast, and a new Context Workbench "Sandboxes" panel shows connection state plus every live E2B workspace with a two-click release. The shared pool gains immutable snapshots, subscriptions, and closed-state guards, and the SDK adapter targets the real `e2b` package with an honest "not bundled in this build" error instead of a broken install hint.

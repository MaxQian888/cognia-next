---
"cognia-next": patch
---

Fix native Tauri commands being blocked by the ACL after the telemetry app-manifest was introduced. Declaring an app ACL manifest turns on Tauri's permission gate for **every** application command invoked from a webview, which silently broke local-account unlock (`account_password_verify not allowed. Command not found`) and every other renderer-invoked command. `build.rs` now regenerates a complete `allow-all-app-commands` grant from the `generate_handler!` list on each build (single source of truth, zero maintenance), and the main-window capability enables it — so trusted local windows keep working while remote/embedded (in-app browser) content stays blocked by the local-only capability context.

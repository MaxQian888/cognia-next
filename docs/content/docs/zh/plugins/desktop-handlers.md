---
title: "Desktop Handlers — Rust ↔ TS Loopback"
description: "Convention for adding new plugin_* Tauri commands to the cognia-next plugin runtime."
---

# Desktop Handlers — Rust ↔ TS Loopback

cognia-next's plugin runtime spans two processes: a Next.js webview that
holds the in-memory plugin manager, and a Rust backend that owns the
filesystem, OS keychain, native notifications, global shortcuts, and the
crypto vault. They talk through Tauri's `invoke()` channel.

ADR 0016 codifies the contract for new `plugin_*` commands. This guide
distills the mechanics so contributors can add a handler without rediscovering
the convention.

## Module layout

Every `plugin_*` Tauri command lives under `src-tauri/src/plugin_api/`:

```
src-tauri/src/plugin_api/
├── mod.rs              // module declarations + PluginRuntimeState struct
├── error.rs            // PluginError + Result alias
├── lifecycle.rs        // plugin_load / enable / disable / unload / install / uninstall / get_all / runtime_snapshot / set_state / get_state
├── permissions.rs      // plugin_permission_grant / list / revoke
├── api_bridge.rs       // plugin_api_invoke / batch_invoke
├── fs_watcher.rs       // plugin_fs_watch / unwatch
├── window_ops.rs       // plugin_window_*
├── shortcut_ops.rs     // plugin_shortcut_register / unregister
├── context_menu.rs     // plugin_context_menu_register / unregister
├── notification.rs     // plugin_show_notification
├── process_ops.rs      // plugin_process_kill
├── backup.rs           // plugin_backup_create / restore / delete
├── signature.rs        // plugin_verify_signature / create_signature / generate_keypair
├── marketplace.rs      // plugin_marketplace_versions / get_directory / download_version / invalidate_cache
├── devtools.rs         // plugin_dev_server_* / watch_* / reload / list_dev_plugins
└── commands.rs         // documentation pointer (no re-exports — see below)
```

## Why no `pub use` re-exports

The `#[tauri::command]` macro generates two helper symbols per command
(`__cmd__name` and `__tauri_command_name_name`) that **don't carry through
`pub use`**. As a result, `tauri::generate_handler!` in `lib.rs` references
each command by its source-module path:

```rust
plugin_api::lifecycle::plugin_load,
plugin_api::permissions::plugin_permission_grant,
```

`commands.rs` is a documentation-only barrel listing the command map.
Don't try to barrel-export — it will fail to compile inside the macro.

## State model

`PluginRuntimeState` is registered exactly once via `.manage()` in
`lib.rs` before `.invoke_handler`:

```rust
.manage(plugin_api::PluginRuntimeState::new(
    dirs::data_dir()
        .map(|d| d.join("cognia").join("plugins"))
        .unwrap_or_else(|| std::path::PathBuf::from(".")),
))
```

Shared mutable maps use `parking_lot::RwLock<HashMap<…>>` for low-frequency
plugin metadata (we don't pull in `dashmap` because the runtime is
sub-100 Hz). Field granularity is per-concern so a permission grant doesn't
block a plugin enumeration.

## Error type

`PluginError` derives `thiserror::Error` and serializes to its display
string for `invoke()` rejection — matching `src-tauri/src/scheduler/error.rs`:

```rust
#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("plugin not found: {0}")] NotFound(String),
    #[error("permission denied: {plugin_id} requested {permission}")]
    PermissionDenied { plugin_id: String, permission: String },
    // …
}

impl serde::Serialize for PluginError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
```

## TS ↔ Rust loopback contract

Some handlers communicate back to the webview by emitting events the TS
side already listens for. The names are load-bearing and must match
exactly. Examples:

| Rust emit                                | TS listener                                        | Source                              |
| ---------------------------------------- | -------------------------------------------------- | ----------------------------------- |
| `plugin-fs-watch:<watch_id>`             | `window.addEventListener("plugin-fs-watch:…")`     | `lib/plugin/core/context.ts:881`    |
| `plugin-shortcut:<plugin_id>:<shortcut>` | `window.addEventListener("plugin-shortcut:…")`     | `lib/plugin/core/context.ts:1129`   |
| `plugin-context-menu:<plugin_id>:<id>`   | `window.addEventListener("plugin-context-menu:…")` | `lib/plugin/core/context.ts:1174`   |
| `plugin-process-exit:<process_id>`       | `window.addEventListener("plugin-process-exit:…")` | `lib/plugin/core/context.ts:1045`   |
| `plugin-hot-reload:<plugin_id>`          | `listen("plugin-hot-reload:…")`                    | `lib/plugin/devtools/hot-reload.ts` |

If you change an event name, you break the contract — TS will silent-fail
through `recordSilentFailure`.

## The `expected: !isTauri()` flip rule

Every TS-side `invoke('plugin_X')` call site has a sibling `recordSilentFailure`
call with an `expected` flag. The convention:

- **Before the Rust handler exists** — `expected: !isTauri()`. In web mode
  the failure is structurally expected; on desktop it's still treated as
  expected because the handler isn't there yet.
- **After the Rust handler ships** — `expected: false`. Desktop-mode
  failures now mean a real bug and should escalate to the Audit panel.

The flip is the contract that ties Tier 1 silent-catch migration to Tier 3
batch landing. Don't ship a Rust handler without flipping the flag at the
matching TS call site, and don't flip the flag without first registering
the handler in `lib.rs`'s `generate_handler!` macro.

The CI gate at `scripts/check-silent-failure-flags.ts` (Tier 4 deliverable
of ADR 0016) catches drift in either direction.

## Test recipe

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::path::PathBuf;

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        PluginRuntimeState::new(PathBuf::from(tmp.path()))
    }

    #[tokio::test]
    async fn my_handler_does_the_thing() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // …
    }
}
```

`tempfile::TempDir` is the ergonomic way to give each test a private
install directory; it's already in `Cargo.toml`'s `[dev-dependencies]`.
The Tauri-managed `State<'_, PluginRuntimeState>` wrapper isn't easily
constructable in unit tests — for behaviours that need it, use
`tauri::test::mock_app()` in an integration test under `src-tauri/tests/`.

## Adding a new handler — checklist

- [ ] Pick the existing module that owns the concern, or add a new file
      under `src-tauri/src/plugin_api/`.
- [ ] If a new module, add `pub mod my_module;` to `mod.rs`.
- [ ] Define the command with `#[tauri::command] pub async fn plugin_X(…)
-> Result<…>`.
- [ ] If shared state is needed, add a field to `PluginRuntimeState` in
      `mod.rs`.
- [ ] Register the command via its full path in `src-tauri/src/lib.rs`'s
      `tauri::generate_handler!` block.
- [ ] Add inline `#[cfg(test)] mod tests` covering happy + error paths.
- [ ] On the TS side, flip the matching `recordSilentFailure` call's
      `expected: !isTauri()` to `expected: false`.
- [ ] Run `cargo build --lib` and `cargo test --lib` from `src-tauri/`.
- [ ] Run `pnpm typecheck` from the repo root.

See ADR 0016 for the per-batch breakdown of every handler shipped under
this convention.

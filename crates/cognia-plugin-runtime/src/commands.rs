//! Module overview / docs entry point.
//!
//! The `#[tauri::command]` macro generates helper symbols (`__cmd__name`,
//! `__tauri_command_name_name`) that don't carry through `pub use` — so
//! the `tauri::generate_handler!` macro in `lib.rs` references each
//! command via its source module path (`plugin_api::lifecycle::plugin_load`,
//! `plugin_api::permissions::plugin_permission_grant`, …) rather than this
//! barrel. We keep this file as a documentation pointer so contributors can
//! find the command list quickly when reviewing batch additions.
//!
//! # Command map
//!
//! | Command                       | Module        | Batch |
//! | ----------------------------- | ------------- | ----- |
//! | `plugin_load`                 | `lifecycle`   | 3a    |
//! | `plugin_enable`               | `lifecycle`   | 3a    |
//! | `plugin_disable`              | `lifecycle`   | 3a    |
//! | `plugin_unload`               | `lifecycle`   | 3a    |
//! | `plugin_install`              | `lifecycle`   | 3a    |
//! | `plugin_uninstall`            | `lifecycle`   | 3a    |
//! | `plugin_get_all`              | `lifecycle`   | 3a    |
//! | `plugin_runtime_snapshot`     | `lifecycle`   | 3a    |
//! | `plugin_set_state`            | `lifecycle`   | 3a    |
//! | `plugin_get_state`            | `lifecycle`   | 3a    |
//! | `plugin_permission_grant`     | `permissions` | 3a    |
//! | `plugin_permission_list`      | `permissions` | 3a    |
//! | `plugin_permission_revoke`    | `permissions` | 3a    |
//! | `plugin_api_invoke`           | `api_bridge`  | 3g    |
//! | `plugin_api_batch_invoke`     | `api_bridge`  | 3g    |

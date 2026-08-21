---
"cognia-next": patch
---

Fix the desktop plugin runtime status sync, which never ran. `PluginManager.syncRuntimeState` invoked `plugin_runtime_snapshot` with no arguments, but that command requires a `pluginId` and returns a single record, so the call always rejected; the legacy fallback then read `plugin_get_all` as a manifest-bearing shape the Rust side has never returned, so every entry failed manifest validation and was skipped. Both branches were dead. The sync now calls the registered no-argument `plugin_get_all` and reads the real snake_case `PluginRuntimeSnapshot` wire shape, surfacing native plugin failures as errors on the plugin card. Statuses that assert a live runtime are deliberately not adopted, so a stale ledger entry after a renderer reload can no longer strand a plugin as "enabled" while it is never actually loaded.

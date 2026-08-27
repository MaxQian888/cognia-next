---
"cognia-next": patch
---

Fix plugin system notifications, which never fired. `ctx.ui.showNotification()` sent a flat `{ title, body, icon }` payload, but the `plugin_show_notification` Tauri command takes a single `args: ShowNotificationArgs` parameter — Tauri resolves command arguments by parameter name, so `args` was absent, the required `title` failed to deserialize, and the call rejected before a notification was ever built. The call site's `try`/`catch` swallowed the rejection into a silent-failure record, so plugins calling `showNotification` produced nothing at all with no visible error.

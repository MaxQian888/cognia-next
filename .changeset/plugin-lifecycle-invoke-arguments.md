---
"cognia-next": patch
---

Plugin backup retention and rollback now call the host with the arguments it actually declares. Backup pruning sent a `path` to `plugin_backup_delete`, which takes `(pluginId, backupId)` and reads no path, so every prune rejected on two missing arguments and the rejection was swallowed as a silent failure. A plugin's backups therefore grew past `maxBackupsPerPlugin` forever. Rollback sent only `pluginId` to `plugin_load`, which also requires the manifest, so every rollback failed at the load step after the target version had already been restored to disk, leaving the plugin unloaded instead of rolled back.

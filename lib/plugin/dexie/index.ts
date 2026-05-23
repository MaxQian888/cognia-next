export { applyPluginTables, removePluginTables, type RetentionMode } from "./bridge"

export {
  getPluginDexieMeta,
  putPluginDexiaMeta,
  deletePluginDexiaMeta,
  getAllPluginDexiaMeta,
} from "./meta"

export {
  PLUGIN_TABLE_NAMESPACE_SEPARATOR,
  MAX_TABLES_PER_PLUGIN,
  isValidPluginTableName,
  toNamespacedTableName,
  fromNamespacedTableName,
} from "./namespace"

export { runPendingMigrations, type MigrationContext } from "./migration-runner"

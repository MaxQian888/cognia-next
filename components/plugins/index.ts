/**
 * Plugin UI barrel — 3-pane shell export surface.
 *
 * The legacy 7-tab layout's helper components — `PluginPanelTabs`,
 * `PluginPanelHeader`, `PluginDetail`, `PluginDetailPanel`,
 * `PluginConfigureTab` — were removed when the new shell became the
 * default. The replacement surfaces live under `./library/*`,
 * `./detail/*`, `./governance/*`, `./discover/*`, and `./devtools/*`;
 * external consumers should depend on `PluginPanel` and the
 * extension-slot APIs rather than reaching into individual panes.
 */

export { PluginPanel } from "./plugin-panel"
export { PluginPanelProvider, usePluginPanel } from "./plugin-panel-context"
export { PluginPanelToolbar } from "./plugin-panel-toolbar"
export { PluginPanelGrid } from "./plugin-panel-grid"
export { PluginCard } from "./plugin-card"
export { PluginCategorySidebar } from "./plugin-category-sidebar"
export { PluginCategorySheet } from "./plugin-category-sheet"
export { PluginBatchActionsBar } from "./plugin-batch-actions-bar"
export { PluginFilterSheet } from "./plugin-filter-sheet"
export { PluginSignatureBadge, type SignatureState } from "./plugin-signature-badge"
export { PluginRowActionsMenu } from "./plugin-row-actions-menu"
export { AuditLogEntry } from "./audit-log-entry"
export { PluginDeleteDialog } from "./plugin-delete-dialog"
export { PluginPermissionReview, PermissionRow } from "./plugin-permission-review"
export {
  PluginConfigForm,
  PluginConfigFormBody,
  PluginConfigFormContent,
} from "./plugin-config-form"
export { PluginExtensionSlot } from "./plugin-extension-slot"
export { PluginMarketplace } from "./plugin-marketplace"
export { PluginMarketplaceCard } from "./plugin-marketplace-card"
export { PluginMarketplaceDetail } from "./plugin-marketplace-detail"
export { PluginImportDialog } from "./plugin-import-dialog"
export { PluginConflictDialog } from "./plugin-conflict-dialog"
export { PluginUpdateDialog, __resetPluginUpdateClientForTests } from "./plugin-update-dialog"
export { PluginRollbackDialog, __resetPluginRollbackClientForTests } from "./plugin-rollback-dialog"
export { PluginBackupPanel, __resetPluginBackupClientForTests } from "./plugin-backup-panel"
export {
  PluginDependencyGraph,
  __resetPluginDependencyResolverForTests,
} from "./plugin-dependency-graph"
export { PluginDevtoolsPanel } from "./plugin-devtools-panel"
export { PluginScheduledJobs } from "./plugin-scheduled-jobs"
export { PluginResourceManager } from "./plugin-resource-manager"
export { PluginAnalytics } from "./plugin-analytics"
export { PluginDiscovery } from "./plugin-discovery"
export { PluginPermissionsTab } from "./plugin-permissions-tab"
export { PluginInstallFromUrlDialog } from "./plugin-install-from-url-dialog"
export { PluginNavSidebar } from "./plugin-nav-sidebar"
export { PluginLibraryPane } from "./library/plugin-library-pane"
export { PluginLibraryHeader } from "./library/plugin-library-header"
export { PluginLibraryList } from "./library/plugin-library-list"
export { PluginLibraryRow } from "./library/plugin-library-row"
export { PluginDetailPane } from "./detail/plugin-detail-pane"
export { PluginGovernancePane } from "./governance/plugin-governance-pane"
export { PluginAuditLog } from "./governance/plugin-audit-log"
export { PluginDiscoverPane } from "./discover/plugin-discover-pane"
export { PluginDevtoolsPane } from "./devtools/plugin-devtools-pane"

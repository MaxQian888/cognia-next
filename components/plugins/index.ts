/**
 * Plugin UI barrel — 3-pane shell export surface.
 *
 * The legacy 7-tab layout's helper components — `PluginPanelTabs`,
 * `PluginPanelHeader`, `PluginDetail`, `PluginDetailPanel`,
 * `PluginConfigureTab` — were removed when the new shell became the
 * default. The replacement surfaces live under `./library/*`,
 * `./detail/*`, `./governance/*`, `./discover/*`, `./devtools/*`,
 * `./marketplace/*`, and `./dialogs/*`; external consumers should
 * depend on `PluginPanel` and the extension-slot APIs rather than
 * reaching into individual panes.
 */

// Top-level shell / infrastructure
export { PluginPanel } from "./plugin-panel"
export { PluginPanelToolbar } from "./plugin-panel-toolbar"
export { PluginPanelGrid } from "./plugin-panel-grid"
export { PluginCard } from "./plugin-card"
export { PluginCategorySidebar } from "./plugin-category-sidebar"
export { PluginBatchActionsBar } from "./plugin-batch-actions-bar"
export { PluginSignatureBadge, type SignatureState } from "./plugin-signature-badge"
export { PluginRowActionsMenu } from "./plugin-row-actions-menu"
export { AuditLogEntry } from "./audit-log-entry"
export { PluginPermissionReview, PermissionRow } from "./plugin-permission-review"
export { PluginExtensionSlot } from "./plugin-extension-slot"
export { PluginBackupPanel, __resetPluginBackupClientForTests } from "./plugin-backup-panel"
export { PluginDiscovery } from "./plugin-discovery"
export { PluginNavSidebar } from "./plugin-nav-sidebar"

// Marketplace browsing
export { PluginMarketplace } from "./marketplace/plugin-marketplace"
export { PluginMarketplaceCard } from "./marketplace/plugin-marketplace-card"
export { PluginMarketplaceDetail } from "./marketplace/plugin-marketplace-detail"

// Dialogs & sheets
export { PluginCategorySheet } from "./dialogs/plugin-category-sheet"
export { PluginFilterSheet } from "./dialogs/plugin-filter-sheet"
export { PluginDeleteDialog } from "./dialogs/plugin-delete-dialog"
export { PluginImportDialog } from "./dialogs/plugin-import-dialog"
export { PluginConflictDialog } from "./dialogs/plugin-conflict-dialog"
export {
  PluginUpdateDialog,
  __resetPluginUpdateClientForTests,
} from "./dialogs/plugin-update-dialog"
export {
  PluginRollbackDialog,
  __resetPluginRollbackClientForTests,
} from "./dialogs/plugin-rollback-dialog"
export { PluginInstallFromUrlDialog } from "./dialogs/plugin-install-from-url-dialog"

// Detail-pane content
export { PluginConfigFormBody, PluginConfigFormContent } from "./detail/plugin-config-form"
export {
  PluginDependencyGraph,
  __resetPluginDependencyResolverForTests,
} from "./detail/plugin-dependency-graph"
export { PluginScheduledJobs } from "./detail/plugin-scheduled-jobs"
export { PluginResourceManager } from "./detail/plugin-resource-manager"
export { PluginAnalytics } from "./detail/plugin-analytics"
export { PluginPermissionsTab } from "./detail/plugin-permissions-tab"
export { PluginDetailPane } from "./detail/plugin-detail-pane"

// Panes (library / governance / discover / devtools)
export { PluginLibraryPane } from "./library/plugin-library-pane"
export { PluginLibraryHeader } from "./library/plugin-library-header"
export { PluginLibraryList } from "./library/plugin-library-list"
export { PluginLibraryRow } from "./library/plugin-library-row"
export { PluginGovernancePane } from "./governance/plugin-governance-pane"
export { PluginAuditLog } from "./governance/plugin-audit-log"
export { PluginDiscoverPane } from "./discover/plugin-discover-pane"
export { PluginDevtoolsPane } from "./devtools/plugin-devtools-pane"

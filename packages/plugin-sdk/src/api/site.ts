/**
 * Plugin SDK — `site` capability surface (ADR-0084).
 *
 * Reads only. Every Sites mutation asserts an authoring capability against a
 * real account id, and a plugin has no account identity of its own, so a write
 * surface would have to borrow the unlocked user's — at which point the
 * authoring policy stops being a policy. See `lib/plugin/api/sites.ts`.
 *
 * Backed by `database:read`; no new canonical permission is minted here.
 */

export type { PluginSiteSummary, PluginSitesAPI } from "@/lib/plugin/api/sites"

export type {
  SiteDeploymentRow,
  SiteDeploymentStatus,
  SiteLifecycle,
  SiteOperationRow,
  SiteOperationStatus,
  SiteOperationType,
  SiteProvider,
  SiteVersionRow,
  SiteVersionStatus,
  SiteVisitorPolicy,
} from "@/types/sites"

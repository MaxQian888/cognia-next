/**
 * The plugin contract's share of `lib/plugin/api/sites.ts`, which re-exports these.
 */
import type {
  SiteDeploymentRow,
  SiteLifecycle,
  SiteOperationRow,
  SiteProvider,
  SiteVersionRow,
  SiteVisitorPolicy,
} from "../../../types/sites"

export interface PluginSiteSummary {
  id: string
  name: string
  projectId: string
  provider: SiteProvider
  workerName: string
  lifecycle: SiteLifecycle
  /** The shape of the visitor policy, never its identities or domains. */
  visitorMode: SiteVisitorPolicy["mode"]
  /** The live URL, when one exists. */
  productionUrl?: string
  createdAt: number
  updatedAt: number
}

export type PluginSiteVersion = Pick<
  SiteVersionRow,
  | "id"
  | "siteId"
  | "sequence"
  | "status"
  | "artifactSize"
  | "artifactFileCount"
  | "artifactCollectedAt"
  | "createdAt"
  | "completedAt"
>

export type PluginSiteDeployment = Pick<
  SiteDeploymentRow,
  "id" | "siteId" | "versionId" | "status" | "productionUrl" | "createdAt" | "updatedAt"
>

export type PluginSiteOperation = Pick<
  SiteOperationRow,
  "id" | "siteId" | "type" | "status" | "attemptCount" | "createdAt" | "updatedAt" | "completedAt"
>

export interface PluginSitesAPI {
  listSites: () => Promise<PluginSiteSummary[]>
  listVersions: (siteId: string) => Promise<PluginSiteVersion[]>
  listDeployments: (siteId: string) => Promise<PluginSiteDeployment[]>
  listOperations: (siteId: string) => Promise<PluginSiteOperation[]>
  getProductionUrl: (siteId: string) => Promise<string | undefined>
}

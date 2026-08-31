/**
 * Plugin-facing view of the user's Cognia Sites.
 *
 * **Reads only, and a projection rather than the row.** Every Sites mutation
 * asserts `assertSiteAuthoringCapability` against an `actorAccountId`, and a
 * plugin has no account identity of its own — it would have to borrow the
 * unlocked user's, at which point the authoring policy stops being a policy.
 * There is also no canonical plugin permission that means "may publish a
 * website"; minting one means editing the contract catalogue and regenerating
 * five artifacts, with its own consent-tier decision. That is a separate slice.
 *
 * What the projection strips, and why each one:
 *
 *  - `providerConfig.accountId` / `zoneId` — Cloudflare tenant identifiers.
 *  - `sourceRoot` / `sourceSubpath` — absolute paths that leak the user's
 *    directory layout.
 *  - `authoringPolicy` — a list of real account ids.
 *  - `visitorPolicy` is flattened to its `mode`; the `identities` and `domains`
 *    variants carry the user's email addresses and allowed domains.
 *
 * The Dexie imports are lazy, like `./scheduler-tasks`: a plugin that never
 * touches Sites should not drag the subsystem into its module graph.
 */
import type {
  SiteDeploymentRow,
  SiteLifecycle,
  SiteOperationRow,
  SiteProvider,
  SiteVersionRow,
  SiteVisitorPolicy,
} from "@/types/sites"

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
  listSites: typeof listSites
  listVersions: typeof listSiteVersionsForPlugin
  listDeployments: typeof listSiteDeploymentsForPlugin
  listOperations: typeof listSiteOperationsForPlugin
  getProductionUrl: typeof getSiteProductionUrl
}

/** Read-only, redacted Sites capability mounted as `ctx.sites`. */
export function createSitesAPI(): PluginSitesAPI {
  return {
    listSites,
    listVersions: listSiteVersionsForPlugin,
    listDeployments: listSiteDeploymentsForPlugin,
    listOperations: listSiteOperationsForPlugin,
    getProductionUrl: getSiteProductionUrl,
  }
}

async function db() {
  return import("@/lib/db/sites")
}

/** Every Site on this machine, as the projection above. */
export async function listSites(): Promise<PluginSiteSummary[]> {
  const { listSiteProjects, listActiveSiteDeployments } = await db()
  const [sites, deployments] = await Promise.all([listSiteProjects(), listActiveSiteDeployments()])
  return sites.map((site) => {
    const deployment = deployments
      .filter((row) => row.siteId === site.id)
      .reduce<SiteDeploymentRow | undefined>(
        (newest, row) => (!newest || row.updatedAt > newest.updatedAt ? row : newest),
        undefined
      )
    return {
      id: site.id,
      name: site.name,
      projectId: site.projectId,
      provider: site.provider,
      workerName: site.providerConfig.workerName,
      lifecycle: site.lifecycle,
      visitorMode: site.visitorPolicy.mode,
      ...(deployment?.productionUrl ? { productionUrl: deployment.productionUrl } : {}),
      createdAt: site.createdAt,
      updatedAt: site.updatedAt,
    }
  })
}

/** Immutable versions of one Site, newest first. */
export async function listSiteVersionsForPlugin(siteId: string): Promise<PluginSiteVersion[]> {
  const { listSiteVersions } = await db()
  return (await listSiteVersions(siteId)).map((row) => ({
    id: row.id,
    siteId: row.siteId,
    sequence: row.sequence,
    status: row.status,
    artifactSize: row.artifactSize,
    artifactFileCount: row.artifactFileCount,
    artifactCollectedAt: row.artifactCollectedAt,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  }))
}

/** Deployment history of one Site. */
export async function listSiteDeploymentsForPlugin(
  siteId: string
): Promise<PluginSiteDeployment[]> {
  const { listSiteDeployments } = await db()
  return (await listSiteDeployments(siteId)).map((row) => ({
    id: row.id,
    siteId: row.siteId,
    versionId: row.versionId,
    status: row.status,
    productionUrl: row.productionUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

/** The durable operation journal of one Site. */
export async function listSiteOperationsForPlugin(siteId: string): Promise<PluginSiteOperation[]> {
  const { listSiteOperations } = await db()
  return (await listSiteOperations(siteId)).map((row) => ({
    id: row.id,
    siteId: row.siteId,
    type: row.type,
    status: row.status,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  }))
}

/** The URL a Site currently serves on, if any. */
export async function getSiteProductionUrl(siteId: string): Promise<string | undefined> {
  const { listSiteDeployments } = await db()
  const { siteProductionUrl } = await import("@/lib/sites/console-model")
  return siteProductionUrl(await listSiteDeployments(siteId))
}

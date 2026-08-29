/**
 * Pure projections for the Sites console.
 *
 * Everything here is derived from rows the Dexie live query already returns —
 * no React, no Dexie, no clock — so the console's reading of its own data is
 * unit-testable on its own. Same placement as `lib/issues/board-model.ts` and
 * `lib/memory/history-filter.ts`.
 *
 * Two functions here deliberately re-derive a classification that
 * `lib/sites/cloudflare/service.ts` already performs internally
 * ({@link purgeRetentionReport} mirrors `purgeManagedResources`,
 * {@link siteObservabilityHostname} mirrors `analytics`). That is the point:
 * the service computes the answer and throws it away, and the user has to see
 * it *before* pressing the button. The suite pins both against the service's
 * behaviour.
 */
import type { SiteAuthoringCapability } from "./authoring-policy"
import type {
  CloudflareSiteProviderConfig,
  SiteAuthoringPolicy,
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationRow,
  SiteResourceKind,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
  SiteVersionStatus,
  SiteVisitorPolicy,
} from "@/types/sites"

/** Render order for the resource tab. Cloudflare's dependency order, roughly. */
export const SITE_RESOURCE_KIND_ORDER: readonly SiteResourceKind[] = [
  "worker",
  "worker-version",
  "custom-domain",
  "d1-database",
  "r2-bucket",
  "secret",
  "access-application",
  "access-policy",
]

export const SITE_VERSION_STATUS_ORDER: readonly SiteVersionStatus[] = [
  "ready",
  "building",
  "failed",
]

/* ------------------------------------------------------------------ header */

/** Newest deployment currently serving traffic, if any. */
export function pickActiveDeployment(
  deployments: readonly SiteDeploymentRow[]
): SiteDeploymentRow | undefined {
  return deployments
    .filter((row) => row.status === "active")
    .reduce<SiteDeploymentRow | undefined>(
      (newest, row) => (!newest || row.updatedAt > newest.updatedAt ? row : newest),
      undefined
    )
}

/**
 * The live site's URL.
 *
 * `deployVersion` writes this on every successful deploy and nothing rendered
 * it, so a finished publish had no visible result at all.
 */
export function siteProductionUrl(deployments: readonly SiteDeploymentRow[]): string | undefined {
  return pickActiveDeployment(deployments)?.productionUrl
}

/** The immutable version behind the active deployment. */
export function currentVersion(
  versions: readonly SiteVersionRow[],
  deployments: readonly SiteDeploymentRow[]
): SiteVersionRow | undefined {
  const active = pickActiveDeployment(deployments)
  return active ? versions.find((version) => version.id === active.versionId) : undefined
}

export type SiteViewerRole = "owner" | "editor" | "deployer" | "viewer"

/**
 * The actor's standing under the Site's authoring policy.
 *
 * Owner outranks the lists; an account named in both lists reads as `editor`,
 * the broader of the two for day-to-day work. `viewer` means every mutating
 * control is disabled — the console says so instead of letting the click throw.
 */
export function siteViewerRole(policy: SiteAuthoringPolicy, accountId: string): SiteViewerRole {
  if (policy.ownerAccountId === accountId) return "owner"
  if (policy.editorAccountIds.includes(accountId)) return "editor"
  if (policy.deployerAccountIds.includes(accountId)) return "deployer"
  return "viewer"
}

/** Capabilities a role holds, mirroring `canAuthorSite`. */
export function siteRoleCapabilities(role: SiteViewerRole): readonly SiteAuthoringCapability[] {
  if (role === "owner") return ["view", "edit", "deploy", "manage"]
  if (role === "editor") return ["view", "edit"]
  if (role === "deployer") return ["view", "deploy"]
  return []
}

/* --------------------------------------------------------------- site rail */

export type SiteRailHintKind = "running" | "live" | "failed" | "never"

export interface SiteRailHint {
  kind: SiteRailHintKind
  tone: "success" | "info" | "danger" | "neutral"
  /** True while an operation is in flight — the rail dot pulses. */
  live: boolean
  /** Timestamp the hint refers to, for relative formatting. */
  at?: number
}

/**
 * One hint per Site in a single pass.
 *
 * The rail called {@link resolveSiteRailHint} per row, and each call filtered
 * the full cross-Site signal lists — O(sites × signals) on every render. This
 * groups both inputs once and answers every row from the grouped maps.
 */
export function indexSiteRailHints(
  sites: readonly Pick<SiteProjectRow, "id">[],
  activeDeployments: readonly SiteDeploymentRow[],
  operationSignals: readonly SiteOperationRow[]
): ReadonlyMap<string, SiteRailHint> {
  const operationsBySite = new Map<string, SiteOperationRow[]>()
  for (const operation of operationSignals) {
    const bucket = operationsBySite.get(operation.siteId)
    if (bucket) bucket.push(operation)
    else operationsBySite.set(operation.siteId, [operation])
  }
  const newestDeployment = new Map<string, SiteDeploymentRow>()
  for (const deployment of activeDeployments) {
    const current = newestDeployment.get(deployment.siteId)
    if (!current || deployment.updatedAt > current.updatedAt) {
      newestDeployment.set(deployment.siteId, deployment)
    }
  }
  const hints = new Map<string, SiteRailHint>()
  for (const site of sites) {
    hints.set(site.id, hintFrom(operationsBySite.get(site.id) ?? [], newestDeployment.get(site.id)))
  }
  return hints
}

/** The precedence rule, shared by both entry points. */
function hintFrom(
  mine: readonly SiteOperationRow[],
  deployment: SiteDeploymentRow | undefined
): SiteRailHint {
  if (mine.some((operation) => operation.status === "queued" || operation.status === "running")) {
    return { kind: "running", tone: "info", live: true }
  }
  // A live Site whose last build failed still reads as live: the failure is
  // surfaced in that Site's overview banner, and the rail should not shout red
  // at a site that is serving traffic fine.
  if (deployment) return { kind: "live", tone: "success", live: false, at: deployment.updatedAt }
  if (mine.length > 0) {
    const newest = mine.reduce((latest, row) => (row.updatedAt > latest.updatedAt ? row : latest))
    return { kind: "failed", tone: "danger", live: false, at: newest.updatedAt }
  }
  return { kind: "never", tone: "neutral", live: false }
}

/**
 * One line of status per Site in the rail, from the cross-Site signals the
 * console loads for every row (active deployments and in-flight operations).
 *
 * Precedence is "what is happening now" over "what happened last": an in-flight
 * operation outranks a live deployment, which outranks a stale failure.
 */
export function resolveSiteRailHint(
  site: Pick<SiteProjectRow, "id">,
  activeDeployments: readonly SiteDeploymentRow[],
  operationSignals: readonly SiteOperationRow[]
): SiteRailHint {
  return hintFrom(
    operationSignals.filter((operation) => operation.siteId === site.id),
    activeDeployments
      .filter((row) => row.siteId === site.id)
      .reduce<SiteDeploymentRow | undefined>(
        (newest, row) => (!newest || row.updatedAt > newest.updatedAt ? row : newest),
        undefined
      )
  )
}

/* ---------------------------------------------------------------- failures */

export interface SiteFailure {
  scope: "version" | "deployment" | "operation"
  /** Row id, so the console can deep-link to the owning tab. */
  id: string
  /** Sequence number, operation type, or deployment id — whatever names the row. */
  label: string
  message: string
  at: number
}

/**
 * Failure text for an operation, or undefined when it has not failed.
 * `waiting-reconcile` counts — an uncertain provider outcome is something the
 * user must act on.
 *
 * This used to fall back to the newest failing *event*'s message, which cost
 * the console a flat array of every operation's events on every live-query
 * re-run. The fallback was unreachable: `failSiteOperation` and
 * `markSiteOperationForReconcile` (`lib/db/sites.ts`) are the only two writers
 * of those statuses and both set `errorMessage` on the row in the same
 * transaction that appends the event.
 */
export function operationFailureText(operation: SiteOperationRow): string | undefined {
  if (operation.status !== "failed" && operation.status !== "waiting-reconcile") return undefined
  return operation.errorMessage
}

/**
 * Every unresolved failure across versions, deployments, and operations,
 * newest first. Drives the console's "needs attention" banner — before this,
 * a failed build left only a red chip and a toast that had already vanished.
 */
export function collectSiteFailures(
  versions: readonly SiteVersionRow[],
  deployments: readonly SiteDeploymentRow[],
  operations: readonly SiteOperationRow[]
): SiteFailure[] {
  const failures: SiteFailure[] = []
  for (const version of versions) {
    if (version.status === "failed" && version.failureMessage) {
      failures.push({
        scope: "version",
        id: version.id,
        label: String(version.sequence),
        message: version.failureMessage,
        at: version.completedAt ?? version.createdAt,
      })
    }
  }
  for (const deployment of deployments) {
    if (deployment.status === "failed" && deployment.failureMessage) {
      failures.push({
        scope: "deployment",
        id: deployment.id,
        label: deployment.id,
        message: deployment.failureMessage,
        at: deployment.updatedAt,
      })
    }
  }
  for (const operation of operations) {
    const message = operationFailureText(operation)
    if (message) {
      failures.push({
        scope: "operation",
        id: operation.id,
        label: operation.type,
        message,
        at: operation.updatedAt,
      })
    }
  }
  return failures.sort((left, right) => right.at - left.at)
}

/* ---------------------------------------------------------------- versions */

/** Version ids Cloudflare has already accepted an upload for. */
export function uploadedVersionIds(resources: readonly SiteResourceRow[]): Set<string> {
  return new Set(
    resources
      .filter((row) => row.kind === "worker-version" && row.status === "active" && row.displayName)
      .map((row) => row.displayName as string)
  )
}

export interface SiteVersionView {
  version: SiteVersionRow
  /** Newest deployment of this exact version, if any. */
  deployment?: SiteDeploymentRow
  uploaded: boolean
  /** True when this version is the one currently serving traffic. */
  live: boolean
}

/** Join versions to their newest deployment and upload state, newest first. */
export function joinVersionsWithDeployments(
  versions: readonly SiteVersionRow[],
  deployments: readonly SiteDeploymentRow[],
  resources: readonly SiteResourceRow[] = []
): SiteVersionView[] {
  const uploaded = uploadedVersionIds(resources)
  const activeId = pickActiveDeployment(deployments)?.versionId
  return [...versions]
    .sort((left, right) => right.sequence - left.sequence)
    .map((version) => {
      const deployment = deployments
        .filter((row) => row.versionId === version.id)
        .reduce<SiteDeploymentRow | undefined>(
          (newest, row) => (!newest || row.updatedAt > newest.updatedAt ? row : newest),
          undefined
        )
      return {
        version,
        ...(deployment ? { deployment } : {}),
        uploaded: uploaded.has(version.id),
        live: version.id === activeId,
      }
    })
}

/** Filter the joined version list by status; `"all"` keeps everything. */
export function filterVersionViews(
  rows: readonly SiteVersionView[],
  status: SiteVersionStatus | "all"
): SiteVersionView[] {
  return status === "all" ? [...rows] : rows.filter((row) => row.version.status === status)
}

/** Count per status, for the versions tab's filter chips. */
export function countVersionsByStatus(
  versions: readonly SiteVersionRow[]
): Record<SiteVersionStatus | "all", number> {
  const counts = { all: versions.length, ready: 0, building: 0, failed: 0 }
  for (const version of versions) counts[version.status] += 1
  return counts
}

/* --------------------------------------------------------------- resources */

export interface SiteResourceGroup {
  kind: SiteResourceKind
  rows: SiteResourceRow[]
}

/**
 * Group provider resources by kind in a stable order. The console rendered
 * only `custom-domain` before, hiding the seven other kinds Cognia creates.
 */
export function groupResourcesByKind(resources: readonly SiteResourceRow[]): SiteResourceGroup[] {
  const groups: SiteResourceGroup[] = []
  for (const kind of SITE_RESOURCE_KIND_ORDER) {
    const rows = resources
      .filter((row) => row.kind === kind)
      .sort((left, right) => left.createdAt - right.createdAt)
    if (rows.length > 0) groups.push({ kind, rows })
  }
  // A kind added to the union but not to the order constant must still render.
  const known = new Set<SiteResourceKind>(SITE_RESOURCE_KIND_ORDER)
  const extra = resources.filter((row) => !known.has(row.kind))
  for (const row of extra) {
    const group = groups.find((candidate) => candidate.kind === row.kind)
    if (group) group.rows.push(row)
    else groups.push({ kind: row.kind, rows: [row] })
  }
  return groups
}

export interface SiteArtifactStorage {
  /** Bytes this Site's surviving archives occupy in IndexedDB. */
  bytes: number
  /** Versions that still hold their archive. */
  stored: number
  /** Versions whose archive retention already took. */
  collected: number
}

/**
 * Local archive footprint, from the summary denormalized onto each version.
 *
 * ADR-0084 requires artifact retention; this is the number that makes it
 * legible before the sweep runs. Deliberately derived from `siteVersions` — the
 * whole point of the denormalized size is that nothing has to open
 * `siteArtifacts` to answer this.
 */
export function siteArtifactStorage(versions: readonly SiteVersionRow[]): SiteArtifactStorage {
  let bytes = 0
  let stored = 0
  let collected = 0
  const counted = new Set<string>()
  for (const version of versions) {
    if (!version.artifactDigest) continue
    if (version.artifactCollectedAt !== undefined) {
      collected += 1
      continue
    }
    stored += 1
    // Content-addressed: two versions with identical output share one row.
    if (counted.has(version.artifactDigest)) continue
    counted.add(version.artifactDigest)
    bytes += version.artifactSize ?? 0
  }
  return { bytes, stored, collected }
}

export interface SitePurgeRetentionReport {
  /** Managed resources purge will actually delete at the provider. */
  purgeable: SiteResourceRow[]
  /** Adopted, shared, or already-orphaned resources purge leaves intact. */
  retained: SiteResourceRow[]
}

/**
 * What a purge would do, mirroring `CloudflareSitesService.purgeManagedResources`:
 * it deletes only `managed` resources that are not already deleted, and marks
 * everything else `orphaned` while leaving the provider object alone.
 *
 * ADR-0084 requires purge to "report adopted/shared resources left intact".
 * This is that report — shown before the confirmation, not after.
 */
export function purgeRetentionReport(
  resources: readonly SiteResourceRow[]
): SitePurgeRetentionReport {
  const live = resources.filter((row) => row.status !== "deleted")
  return {
    purgeable: live.filter((row) => row.ownership === "managed"),
    retained: live.filter((row) => row.ownership !== "managed"),
  }
}

/**
 * Hostname the provider analytics query will actually use, mirroring
 * `CloudflareSitesService.analytics`: the first active custom domain, else the
 * newest deployment's production host. Undefined means the query degrades to
 * worker-scope data, which the console warns about instead of silently
 * returning thinner numbers.
 */
export function siteObservabilityHostname(
  resources: readonly SiteResourceRow[],
  deployments: readonly SiteDeploymentRow[]
): string | undefined {
  const domain = resources.find(
    (row) => row.kind === "custom-domain" && row.status === "active" && row.displayName
  )
  if (domain?.displayName) return domain.displayName
  const newest = [...deployments].sort((left, right) => right.updatedAt - left.updatedAt)[0]
  if (!newest?.productionUrl) return undefined
  try {
    return new URL(newest.productionUrl).hostname
  } catch {
    return undefined
  }
}

/** True when analytics will be zone-scoped rather than degraded. */
export function siteAnalyticsIsZoneScoped(
  providerConfig: Pick<CloudflareSiteProviderConfig, "zoneId">
): boolean {
  return Boolean(providerConfig.zoneId?.trim())
}

/* ----------------------------------------------------------- visitor access */

/** True when the visitor policy puts the Site behind Cloudflare Access. */
export function siteIsAccessProtected(policy: SiteVisitorPolicy): boolean {
  return policy.mode !== "public"
}

/**
 * Where visitors of a protected Site actually authenticate.
 *
 * Cloudflare Access applications are account-scoped, so the provider API never
 * needs the team name — which is why `accessTeamName` sat in the type with zero
 * readers. It is still the one thing the owner cannot derive: the login origin
 * their visitors are redirected to, and the console that configures the identity
 * providers behind it.
 */
export function siteAccessLoginUrl(
  providerConfig: Pick<CloudflareSiteProviderConfig, "accessTeamName">
): string | undefined {
  const team = providerConfig.accessTeamName?.trim()
  if (!team) return undefined
  // Accept either the bare team name or the full team domain.
  const host = team.includes(".") ? team : `${team}.cloudflareaccess.com`
  return `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
}

/**
 * The Site enforces a visitor policy but nothing records where that enforcement
 * happens — the console asks for the team name instead of leaving the owner to
 * discover it in the Cloudflare dashboard.
 */
export function siteAccessTeamMissing(
  policy: SiteVisitorPolicy,
  providerConfig: Pick<CloudflareSiteProviderConfig, "accessTeamName">
): boolean {
  return siteIsAccessProtected(policy) && !providerConfig.accessTeamName?.trim()
}

/* ------------------------------------------------------------- environment */

/** Newest environment revision by sequence. */
export function latestEnvironmentRevision(
  environments: readonly SiteEnvironmentRevisionRow[]
): SiteEnvironmentRevisionRow | undefined {
  return environments.reduce<SiteEnvironmentRevisionRow | undefined>(
    (newest, row) => (!newest || row.sequence > newest.sequence ? row : newest),
    undefined
  )
}

/** Revisions newest-first, for the history list. */
export function sortEnvironmentRevisions(
  environments: readonly SiteEnvironmentRevisionRow[]
): SiteEnvironmentRevisionRow[] {
  return [...environments].sort((left, right) => right.sequence - left.sequence)
}

export interface SiteEnvironmentDiff {
  added: string[]
  changed: string[]
  removed: string[]
}

/**
 * What saving these variables would do to the current revision.
 *
 * `saveEnvironment` replaces the whole variable set, so an editor seeded from
 * an empty textarea silently wiped everything. The console shows this diff
 * before the write.
 */
export function environmentRevisionDiff(
  previous: SiteEnvironmentRevisionRow | undefined,
  next: Record<string, string>
): SiteEnvironmentDiff {
  const before = previous?.variables ?? {}
  const added: string[] = []
  const changed: string[] = []
  for (const [key, value] of Object.entries(next)) {
    if (!Object.hasOwn(before, key)) added.push(key)
    else if (before[key] !== value) changed.push(key)
  }
  const removed = Object.keys(before).filter((key) => !Object.hasOwn(next, key))
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

/** True when the diff would change nothing — the save button can say so. */
export function environmentDiffIsEmpty(diff: SiteEnvironmentDiff): boolean {
  return diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0
}

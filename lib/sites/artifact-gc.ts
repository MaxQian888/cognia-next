/**
 * Artifact retention for Cognia Sites (ADR-0084).
 *
 * The ADR requires that "artifact retention and garbage collection must
 * preserve every version referenced by a deployment or unfinished operation".
 * Only the whole-Site deletion path ever deleted an archive, so `siteArtifacts`
 * — which stores complete build outputs as `Uint8Array` — grew without bound
 * for the lifetime of the profile.
 *
 * What survives a sweep, and why each rule exists:
 *
 *  1. **Anything a deployment points at.** `pending` / `deploying` / `active`
 *     are serving or about to serve. The newest `superseded` deployment per
 *     Site is the rollback target — deleting its artifact turns "roll back" into
 *     "rebuild and hope".
 *  2. **Every artifact of a Site with a non-terminal operation.** Coarse on
 *     purpose: `recoverInterruptedOperations` replays from `inputPayload`, and
 *     reasoning per operation about which version it will land on is a way to
 *     be wrong while a build is in flight. A Site with nothing running is the
 *     common case, so the coarseness costs nothing in practice.
 *  3. **The newest N ready versions per Site.** The rollback window a user
 *     expects to still be there.
 *  4. **Anything newer than the retention window.**
 *
 * Enumeration goes through `listSiteArtifactDigests`, which reads primary keys
 * only — walking the table itself would structured-clone every archive the
 * sweep is about to decide it can keep.
 */
import {
  deleteSiteArtifacts,
  deleteSiteBuildLogsForVersions,
  listSiteArtifactDigests,
  listSiteDeployments,
  listSiteOperations,
  listSiteProjects,
  listSiteVersions,
  markSiteVersionArtifactCollected,
} from "@/lib/db/sites"
import type { SiteDeploymentRow, SiteOperationRow, SiteVersionRow } from "@/types/sites"

/** Statuses that can still change, so their Site's artifacts are all pinned. */
const NON_TERMINAL: ReadonlySet<SiteOperationRow["status"]> = new Set([
  "queued",
  "running",
  "waiting-reconcile",
])

/** Deployment statuses that pin their version's artifact outright. */
const SERVING: ReadonlySet<SiteDeploymentRow["status"]> = new Set([
  "pending",
  "deploying",
  "active",
])

export interface SiteArtifactGcInput {
  now: number
  /** Artifacts newer than this many days are always kept. */
  keepDays: number
  /** Rollback window: the newest N ready versions per Site keep their bytes. */
  keepReadyVersionsPerSite: number
}

export interface SiteArtifactGcReport {
  /** Digests present before the sweep. */
  scanned: number
  deletedDigests: string[]
  /** Bytes recovered, from the denormalized summary on the version rows. */
  bytesFreed: number
  /** Build-log rows removed alongside the archives they explain. */
  buildLogsDeleted: number
  /** Digests kept because a deployment or an unfinished operation needs them. */
  retainedReferenced: number
  /** Digests kept by the rollback window or the age window. */
  retainedRecent: number
}

export interface SiteArtifactGcDeps {
  listProjects: typeof listSiteProjects
  listVersions: typeof listSiteVersions
  listDeployments: typeof listSiteDeployments
  listOperations: typeof listSiteOperations
  listDigests: typeof listSiteArtifactDigests
  deleteArtifacts: typeof deleteSiteArtifacts
  deleteBuildLogs: typeof deleteSiteBuildLogsForVersions
  markCollected: typeof markSiteVersionArtifactCollected
}

function defaults(): SiteArtifactGcDeps {
  return {
    listProjects: listSiteProjects,
    listVersions: listSiteVersions,
    listDeployments: listSiteDeployments,
    listOperations: listSiteOperations,
    listDigests: listSiteArtifactDigests,
    deleteArtifacts: deleteSiteArtifacts,
    deleteBuildLogs: deleteSiteBuildLogsForVersions,
    markCollected: markSiteVersionArtifactCollected,
  }
}

export const SITE_ARTIFACT_GC_DEFAULTS = {
  keepDays: 30,
  keepReadyVersionsPerSite: 5,
} as const

/**
 * Which digests one Site pins, and which of its versions would lose their
 * bytes. Pure — every caller passes rows it already has.
 */
export interface SitePinnedArtifacts {
  /** Kept because a deployment or an unfinished operation needs the bytes. */
  referenced: Set<string>
  /** Kept by the rollback window or the age window. */
  recent: Set<string>
  /** Versions whose bytes this sweep would take. */
  collectable: SiteVersionRow[]
}

export function pinnedSiteArtifactDigests(
  versions: readonly SiteVersionRow[],
  deployments: readonly SiteDeploymentRow[],
  operations: readonly SiteOperationRow[],
  input: SiteArtifactGcInput
): SitePinnedArtifacts {
  const referenced = new Set<string>()
  const recent = new Set<string>()
  const digestOf = new Map<string, string>()
  for (const version of versions) {
    if (version.artifactDigest) digestOf.set(version.id, version.artifactDigest)
  }

  // Rule 2 — anything in flight pins the whole Site.
  if (operations.some((operation) => NON_TERMINAL.has(operation.status))) {
    for (const digest of digestOf.values()) referenced.add(digest)
    return { referenced, recent, collectable: [] }
  }

  // Rule 1 — serving deployments, plus the newest superseded one as the
  // rollback target.
  let newestSuperseded: SiteDeploymentRow | undefined
  for (const deployment of deployments) {
    if (SERVING.has(deployment.status)) {
      const digest = digestOf.get(deployment.versionId)
      if (digest) referenced.add(digest)
    }
    if (
      deployment.status === "superseded" &&
      (!newestSuperseded || deployment.updatedAt > newestSuperseded.updatedAt)
    ) {
      newestSuperseded = deployment
    }
  }
  if (newestSuperseded) {
    const digest = digestOf.get(newestSuperseded.versionId)
    if (digest) referenced.add(digest)
  }

  // Rule 3 — the rollback window.
  const ready = versions
    .filter((version) => version.status === "ready" && version.artifactDigest)
    .sort((left, right) => right.sequence - left.sequence)
  for (const version of ready.slice(0, Math.max(0, input.keepReadyVersionsPerSite))) {
    recent.add(version.artifactDigest as string)
  }

  // Rule 4 — the age window.
  const cutoff = input.now - Math.max(0, input.keepDays) * 86_400_000
  for (const version of versions) {
    if (!version.artifactDigest) continue
    if ((version.completedAt ?? version.createdAt) >= cutoff) recent.add(version.artifactDigest)
  }

  const collectable = versions.filter(
    (version) =>
      version.artifactDigest !== undefined &&
      version.artifactCollectedAt === undefined &&
      !referenced.has(version.artifactDigest) &&
      !recent.has(version.artifactDigest)
  )
  return { referenced, recent, collectable }
}

/**
 * Sweep every Site and delete the archives nothing needs any more.
 *
 * A collected version keeps `status: "ready"` — it really did build — but is
 * marked so the console can say "artifact pruned, rebuild to redeploy" instead
 * of offering an Upload that would fail on a missing archive.
 */
export async function collectUnreferencedSiteArtifacts(
  input: SiteArtifactGcInput,
  dependencies?: Partial<SiteArtifactGcDeps>
): Promise<SiteArtifactGcReport> {
  const deps = { ...defaults(), ...dependencies }
  const allDigests = await deps.listDigests()
  const referenced = new Set<string>()
  const recent = new Set<string>()
  const collectable: SiteVersionRow[] = []

  for (const site of await deps.listProjects()) {
    const [versions, deployments, operations] = await Promise.all([
      deps.listVersions(site.id),
      deps.listDeployments(site.id),
      deps.listOperations(site.id),
    ])
    const result = pinnedSiteArtifactDigests(versions, deployments, operations, input)
    for (const digest of result.referenced) referenced.add(digest)
    for (const digest of result.recent) recent.add(digest)
    collectable.push(...result.collectable)
  }

  // A digest pinned by one Site is pinned outright: artifacts are
  // content-addressed, so two Sites that built byte-identical output share one
  // row and deleting it for one would break the other.
  const doomed = allDigests.filter((digest) => !referenced.has(digest) && !recent.has(digest))
  const doomedSet = new Set(doomed)
  const losing = collectable.filter((version) => doomedSet.has(version.artifactDigest as string))

  let buildLogsDeleted = 0
  let bytesFreed = 0
  const counted = new Set<string>()
  for (const version of losing) {
    const digest = version.artifactDigest as string
    if (!counted.has(digest)) {
      counted.add(digest)
      bytesFreed += version.artifactSize ?? 0
    }
  }

  if (doomed.length > 0) {
    await deps.deleteArtifacts(doomed)
    // The captured build output goes with the archive it explains. A version
    // that can no longer be republished does not need half a megabyte of its
    // compiler's stdout kept forever, and `siteBuildLogs` would otherwise
    // become the next unbounded table.
    buildLogsDeleted = await deps.deleteBuildLogs(losing.map((version) => version.id))
    for (const version of losing) await deps.markCollected(version.id, input.now)
  }

  return {
    scanned: allDigests.length,
    deletedDigests: doomed,
    bytesFreed,
    buildLogsDeleted,
    retainedReferenced: allDigests.filter((digest) => referenced.has(digest)).length,
    // `referenced` wins the label when a digest is pinned twice, so the two
    // counts plus the deletions always add up to `scanned`.
    retainedRecent: allDigests.filter((digest) => !referenced.has(digest) && recent.has(digest))
      .length,
  }
}

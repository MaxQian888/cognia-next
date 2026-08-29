/**
 * Turning a ready {@link SiteVersionRow} into a live deployment, in one place.
 *
 * This derivation used to live only inside a React `useCallback` in
 * `hooks/sites/use-site-publish-actions.ts`: resolve wrangler, pull the
 * content-addressed archive out of Dexie, materialize it into a staging
 * directory under the app cache, then hand five absolute paths to
 * `CloudflareSitesService.uploadVersion`. `uploadVersion` requires all five
 * from its caller and `deployVersion` refuses a version with no active
 * `worker-version` resource — so anything that is not the console (a workflow
 * node, an agent tool, a scheduled publish) had no way to publish without
 * copying the whole sequence.
 *
 * Every host-privileged edge is injectable so the unit suite can drive the
 * whole path without Tauri.
 */
import { getSiteArtifact, getSiteVersion, listSiteResources } from "@/lib/db/sites"
import { createDir } from "@/lib/file/file-operations"
import { CloudflareSitesService } from "@/lib/sites/cloudflare/service"
import { materializeSiteArtifact } from "@/lib/sites/artifact-package"
import { ensureWranglerApproved, type WranglerDetection } from "@/lib/sites/wrangler-detect"
import type { SiteDeploymentRow, SiteVersionRow } from "@/types/sites"

export interface PublishSiteVersionInput {
  siteId: string
  versionId: string
  actorAccountId: string
}

export interface PublishSiteVersionDeps {
  /** Resolves wrangler and approves its exact bytes in the Sites tool ledger. */
  ensureWrangler: () => Promise<WranglerDetection>
  getArtifact: typeof getSiteArtifact
  getVersion: typeof getSiteVersion
  listResources: typeof listSiteResources
  materialize: typeof materializeSiteArtifact
  mkdir: typeof createDir
  join: (...parts: string[]) => Promise<string>
  cacheRoot: () => Promise<string>
  createService: (actorAccountId: string) => CloudflareSitesService
}

function defaults(): PublishSiteVersionDeps {
  return {
    ensureWrangler: () => ensureWranglerApproved(),
    getArtifact: getSiteArtifact,
    getVersion: getSiteVersion,
    listResources: listSiteResources,
    materialize: materializeSiteArtifact,
    mkdir: createDir,
    join: async (...parts) => {
      const path = await import("@tauri-apps/api/path")
      return path.join(...parts)
    },
    cacheRoot: async () => {
      const path = await import("@tauri-apps/api/path")
      return path.appCacheDir()
    },
    createService: (actorAccountId) => new CloudflareSitesService({ actorAccountId }),
  }
}

/**
 * True when Cloudflare has already accepted an upload for this exact version.
 *
 * `uploadVersion` is not idempotent at the provider — it creates a new worker
 * version every call — so a publish that already has one must skip straight to
 * deploy rather than paying for (and recording) a duplicate.
 */
export async function siteVersionIsUploaded(
  siteId: string,
  versionId: string,
  deps?: Pick<Partial<PublishSiteVersionDeps>, "listResources">
): Promise<boolean> {
  const listResources = deps?.listResources ?? defaults().listResources
  return (await listResources(siteId)).some(
    (row) =>
      row.kind === "worker-version" && row.displayName === versionId && row.status === "active"
  )
}

/**
 * Upload one ready version's artifact to Cloudflare.
 *
 * Returns the provider's worker-version id. Throws with an actionable message
 * when wrangler is missing, the version never produced an artifact, or the
 * artifact bytes have been garbage-collected.
 */
export async function uploadSiteVersion(
  input: PublishSiteVersionInput,
  dependencies?: Partial<PublishSiteVersionDeps>
): Promise<string> {
  const deps = { ...defaults(), ...dependencies }
  const version = await resolveReadyVersion(input, deps.getVersion)

  const wrangler = await deps.ensureWrangler()
  if (!wrangler.path) throw new Error("wrangler binary required")

  const artifact = await deps.getArtifact(version.artifactDigest as string)
  if (!artifact) throw new Error("version artifact required")

  const stagingRoot = await deps.join(
    await deps.cacheRoot(),
    "cognia-sites",
    input.siteId,
    input.versionId
  )
  await deps.mkdir(stagingRoot, { recursive: true })
  const materialized = await deps.materialize(artifact.bytes, stagingRoot)

  return deps.createService(input.actorAccountId).uploadVersion(input.siteId, input.versionId, {
    wranglerBinaryPath: wrangler.path,
    stagingRoot,
    configPath: await deps.join(stagingRoot, "wrangler.json"),
    entryPath: materialized.entryPath,
    ...(materialized.assetsPath ? { assetsPath: materialized.assetsPath } : {}),
  })
}

/**
 * Upload (when needed) and deploy in one step.
 *
 * Upload and deploy are not two independent user intentions: `deployVersion`
 * refuses an un-uploaded version, so exposing them separately outside the
 * console only creates a state where a flow can stop half-published.
 */
export async function publishSiteVersion(
  input: PublishSiteVersionInput,
  dependencies?: Partial<PublishSiteVersionDeps>
): Promise<SiteDeploymentRow> {
  const deps = { ...defaults(), ...dependencies }
  if (!(await siteVersionIsUploaded(input.siteId, input.versionId, deps))) {
    await uploadSiteVersion(input, deps)
  }
  return deps
    .createService(input.actorAccountId)
    .deployVersion(input.siteId, input.versionId) as Promise<SiteDeploymentRow>
}

/**
 * The version, proven ready and artifact-backed before any provider call.
 *
 * `uploadVersion` re-checks all of this, but only after the caller has already
 * hashed a binary and written an archive to disk — so the cheap refusal
 * belongs here.
 */
async function resolveReadyVersion(
  input: PublishSiteVersionInput,
  getVersion: typeof getSiteVersion
): Promise<SiteVersionRow> {
  const version = await getVersion(input.versionId)
  if (!version || version.siteId !== input.siteId || version.status !== "ready") {
    throw new Error("ready Site version not found")
  }
  if (!version.artifactDigest) throw new Error("version artifact required")
  return version
}

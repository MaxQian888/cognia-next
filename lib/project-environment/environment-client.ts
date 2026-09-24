/**
 * The brain's reader for the Host's environment plane (ADR-0182).
 *
 * Sixteen companion commands, one module. Each function is a thin typed call
 * so the wire names live in exactly one place and a surface never spells one
 * out: `rpc/environment.rs` is the authority on shape, `protocol/
 * companion-response-schemas.json` is the published contract, and the types
 * below are that contract read back.
 *
 * # Why the declaration comes back as bytes
 *
 * `environmentDeclarationRead` returns every declaration file's *contents*
 * and digest rather than a parsed declaration, and does not pick a winner
 * between them. The Host deliberately does neither: the one devcontainer/JSONC
 * parser lives in `./devcontainer.ts` and the precedence rule in
 * `./read-environment-declaration.ts`, so a Host that parsed or chose would be
 * a second answer to a question that already has one. `declarationReader`
 * below turns the Host's bytes into the `readFile` dependency that resolver
 * expects.
 *
 * # Why every call can refuse
 *
 * The whole plane is behind the deployment switch (Q39). With the pool off,
 * every command answers `sandbox_pool_disabled`, which is not an error to
 * report but the ordinary state of a deployment that never opted in —
 * `isPoolDisabled` exists so callers can take the off path instead of
 * surfacing a failure.
 */

import { parseInvokeError } from "@/lib/tauri/command-error"
import { collectPages, type Page, type PageRequest } from "@/lib/tauri/companion-paging"
import { transport } from "@/lib/tauri/transport-instance"
import type { EgressTier, IsolationTier, PinnedImage } from "@/types/sandbox/environment-spec"
import type {
  CatalogEntrySource,
  CatalogImageView,
  CatalogScope,
  EgressPresetView,
  EnvironmentCatalogEntryView,
  EnvironmentCatalogView,
  SizeClassView,
} from "@/types/sandbox/environment-catalog"

/** A catalog entry as the store holds it. Writable by a tenant admin. */
export interface CatalogEntryRecord {
  id: string
  scope: CatalogScope
  label: string
  description?: string
  image: CatalogImageView
  isolationFloor: IsolationTier
  /** The first is the default. */
  sizeClassIds: string[]
  imageUser?: string
  source: CatalogEntrySource
  provenance?: unknown
  revokedAt?: number
  /** Server-owned. `0` means "not recorded", which a hand-authored baseline entry is. */
  createdAt: number
  updatedAt: number
}

/** One entry plus what the merge decided about it. */
export interface CatalogEntryRow {
  entry: CatalogEntryRecord
  /** The strictest of the entry's, the tenant's and the baseline's floors. */
  effectiveFloor: IsolationTier
  defaultEntry: boolean
}

/** A tenant entry the merge refused because it would widen the baseline. */
export interface CatalogRejectionRow {
  id: string
  code: string
  message: string
}

/** An agent bundle the deployment offers. */
export interface OfferedBundle {
  registry: string
  repository: string
  digest: string
  releaseTag: string
}

/**
 * One page of entries plus the deployment-level facts resolution needs.
 *
 * The switch, the floor, the size classes and the bundle offer repeat on every
 * page, like `rejected`: they are read from the same merge the entries are, and
 * a second command for them would let a caller resolve against a catalog whose
 * halves came from two different reads.
 */
export interface CatalogPage extends Page<CatalogEntryRow> {
  rejected: CatalogRejectionRow[]
  poolEnabled: boolean
  multiTenant: boolean
  floor: IsolationTier
  defaultEntryId?: string
  sizeClasses: SizeClassView[]
  egressPresets: EgressPresetView[]
  bundle?: { current: OfferedBundle; retained: OfferedBundle[] }
}

/** The declaration file the Host found, unparsed. */
export interface DeclarationReadRow {
  path: string
  relativePath: string
  /** `workspace-config` or `devcontainer`. */
  file: string
  contents: string
  bytesSha256: string
}

export interface DeclarationReadResult {
  /** Every declaration file present, in precedence order. Empty is the common case. */
  files: DeclarationReadRow[]
  /** Every path the Host looked at, in precedence order. */
  searched: string[]
}

/** A dry run of admission against a resolved spec. */
export interface SpecPreview {
  admitted: boolean
  specDigest?: string
  actualTier?: IsolationTier
  sizeClassId?: string
  bundleDigest?: string
  availableTiers: IsolationTier[]
  refusalCode?: string
  refusalMessage?: string
  /** True when the refusal was infrastructure rather than policy (ADR-0182 fault rule). */
  fault: boolean
}

export interface EnvironmentRuntimePort {
  containerId: string
  projectId: string
  port: number
  label?: string
  path: string
}

export async function environmentPortsList(projectId: string): Promise<EnvironmentRuntimePort[]> {
  const result = await transport.call<{ ports: EnvironmentRuntimePort[] }>(
    "environment_ports_list",
    { projectId }
  )
  return result.ports
}

export interface EnvironmentBuildRecord {
  runtimeConfiguration: unknown
  buildKey: string
  imageId: string
  projectId: string
  commitSha: string
  declarationPath: string
  declarationDigest: string
  declarationBytesSha256: string
  sourceHash: string
  cliVersion: string
  platform: string
  createdAt: number
}

export interface EnvironmentBuildStatus {
  jobId: string
  projectId: string
  status: "queued" | "building" | "succeeded" | "failed" | "cancelled"
  record?: EnvironmentBuildRecord
  error?: string
}

export interface EnvironmentBuildRequest {
  projectId: string
  cwd: string
  declarationPath: string
  declarationDigest: string
  declarationBytesSha256: string
  commitSha: string
  platform?: string
}

export function environmentBuildStart(
  request: EnvironmentBuildRequest
): Promise<EnvironmentBuildStatus> {
  return transport.call("environment_build_start", { request })
}

export function environmentBuildGet(query: {
  projectId: string
  jobId?: string
  buildKey?: string
}): Promise<EnvironmentBuildStatus> {
  return transport.call("environment_build_get", query)
}

export function environmentBuildCancel(
  projectId: string,
  jobId: string
): Promise<EnvironmentBuildStatus> {
  return transport.call("environment_build_cancel", { projectId, jobId })
}

export type ApprovalAuthority = "workspaceMaintainer" | "orgAdmin" | "hostOwner"

export interface ApprovalRecord {
  id: string
  projectId: string
  normalizedRemote: string
  path: string
  declarationDigest: string
  resolvedImage?: PinnedImage
  buildKey?: string
  runtimeFieldsDigest: string
  approverUserId: string
  via: ApprovalAuthority
  approvedAt: number
  revokedAt?: number
  revokedBy?: string
}

/** What a caller asks to have approved. The approver and moment are the Host's. */
export interface ApprovalRequest {
  id: string
  projectId: string
  normalizedRemote: string
  path: string
  declarationDigest: string
  resolvedImage?: PinnedImage
  buildKey?: string
  runtimeFieldsDigest: string
}

export interface EgressGrant {
  id: string
  projectId: string
  tier: EgressTier
  domains: string[]
  grantedBy: string
  grantedAt: number
  revokedAt?: number
}

export interface EgressGrantRequest {
  id: string
  projectId: string
  tier: EgressTier
  domains?: string[]
}

/** A numeric owner, as `stat` reports it. */
export interface ProbeOwner {
  uid: number
  gid: number
}

/** A probe verdict the driver cached for one (user image, bundle) pair. */
export interface ProbeCacheRow {
  version: number
  /** The user the probe was asked about: a name, a uid, or `uid:gid`. */
  requestedUser: string
  /** Who the agent actually runs as; absent when that user is not in the image. */
  resolvedUser?: {
    name?: string
    uid: number
    gid: number
    /** The declared user's own ids, when it was remapped onto the workspace owner. */
    remappedFrom?: ProbeOwner
  }
  matchWorkspaceOwner: boolean
  workspaceOwner?: ProbeOwner
  libc?: string
  arch: string
  shell?: string
  /** Bundle runtimes this image's C library can run. */
  runtimes: string[]
  /** `probe_*` (or `bundle_arch_mismatch`) problems; empty when the image was accepted. */
  problems: Array<{ code: string; message: string }>
}

export interface ProbeCacheResult {
  cached?: ProbeCacheRow
  /** The cache file exists but could not be read; treat as a cache miss. */
  unreadable: boolean
}

/**
 * An offered bundle as the driver reports it. A distinct name from
 * {@link OfferedBundle}: two interfaces of one name merge, which would make
 * `current` required on the catalog page's bundles too.
 */
export interface OfferedBundleView extends OfferedBundle {
  /** True for the current bundle, false for a retained older one. */
  current: boolean
}

export interface DriverStatus {
  driver: string
  deploymentId: string
  instanceId: string
  multiTenant: boolean
  isolationFloor: IsolationTier
  availableTiers: IsolationTier[]
  reachable: boolean
  unreachableReason?: string
  bundles: OfferedBundleView[]
}

/** The refusal every command answers when the deployment never enabled the pool. */
export const POOL_DISABLED_CODE = "sandbox_pool_disabled"

/**
 * Whether a rejection is "this deployment has no pool" rather than a failure.
 *
 * Callers on the run path branch on this to take the existing execution path
 * unchanged (Q39) instead of reporting an error a person cannot act on.
 */
export function isPoolDisabled(error: unknown): boolean {
  return parseInvokeError(error).code === POOL_DISABLED_CODE
}

export function environmentCatalogList(request: PageRequest = {}): Promise<CatalogPage> {
  return transport.call<CatalogPage>("environment_catalog_list", { ...request })
}

export function environmentCatalogGet(id: string): Promise<CatalogEntryRow | null> {
  return transport.call<CatalogEntryRow | null>("environment_catalog_get", { id })
}

export function environmentCatalogCreate(entry: CatalogEntryRecord): Promise<CatalogEntryRecord> {
  return transport.call<CatalogEntryRecord>("environment_catalog_create", { entry })
}

export function environmentCatalogUpdate(entry: CatalogEntryRecord): Promise<CatalogEntryRecord> {
  return transport.call<CatalogEntryRecord>("environment_catalog_update", { entry })
}

/** Revokes a tenant entry and returns it; a missing id is `environment_record_not_found`. */
export function environmentCatalogDelete(id: string): Promise<CatalogEntryRecord> {
  return transport.call<CatalogEntryRecord>("environment_catalog_delete", { id })
}

export function environmentDeclarationRead(workspaceRoot: string): Promise<DeclarationReadResult> {
  return transport.call<DeclarationReadResult>("environment_declaration_read", { workspaceRoot })
}

export function environmentSpecResolvePreview(spec: unknown): Promise<SpecPreview> {
  return transport.call<SpecPreview>("environment_spec_resolve_preview", { spec })
}

export function environmentApprovalList(
  options: PageRequest & { projectId?: string; includeRevoked?: boolean } = {}
): Promise<Page<ApprovalRecord>> {
  return transport.call<Page<ApprovalRecord>>("environment_approval_list", { ...options })
}

/** Read the complete project ledger; partial authority data cannot resolve a run. */
export function fetchEnvironmentApprovals(projectId: string): Promise<ApprovalRecord[]> {
  return collectPages(
    (pageToken) =>
      environmentApprovalList({
        projectId,
        pageSize: 200,
        ...(pageToken === undefined ? {} : { pageToken }),
      }),
    { requireComplete: true }
  )
}

export function environmentApprovalGet(id: string): Promise<ApprovalRecord | null> {
  return transport.call<ApprovalRecord | null>("environment_approval_get", { id })
}

export function environmentApprovalApprove(approval: ApprovalRequest): Promise<ApprovalRecord> {
  return transport.call<ApprovalRecord>("environment_approval_approve", { approval })
}

export function environmentApprovalRevoke(id: string): Promise<ApprovalRecord> {
  return transport.call<ApprovalRecord>("environment_approval_revoke", { id })
}

export function environmentEgressGrantCreate(grant: EgressGrantRequest): Promise<EgressGrant> {
  return transport.call<EgressGrant>("environment_egress_grant_create", { grant })
}

export function environmentEgressGrantDelete(id: string): Promise<EgressGrant> {
  return transport.call<EgressGrant>("environment_egress_grant_delete", { id })
}

export function environmentProbeGet(
  userImageDigest: string,
  bundleDigest: string
): Promise<ProbeCacheResult> {
  return transport.call<ProbeCacheResult>("environment_probe_get", {
    userImageDigest,
    bundleDigest,
  })
}

export function environmentDriverStatus(): Promise<DriverStatus> {
  return transport.call<DriverStatus>("environment_driver_status", {})
}

/** One platform an image offers, and what its config declares. */
export interface PlatformImage {
  platform: { os: string; architecture: string; variant?: string }
  manifestDigest: string
  configDigest: string
  /** The config's `User`; absent means root. */
  user?: string
  env: string[]
  workingDir?: string
}

/** What an image reference is, as the registry answered. */
export interface ImageMetadata {
  registry: string
  repository: string
  /** The index digest for a multi-platform image, the manifest digest otherwise. */
  digest: string
  mediaType: string
  platforms: PlatformImage[]
}

/**
 * Resolve an image reference against its registry.
 *
 * The one way a tag becomes a digest: an approval and a catalog entry both pin
 * what runs, and a tag the registry later moves must not change it. Only a
 * registry on the deployment's allowlist is contacted.
 */
export function environmentImageInspect(reference: string): Promise<ImageMetadata> {
  return transport.call<ImageMetadata>("environment_image_inspect", { reference })
}

/**
 * The user every platform agrees on, `undefined` for root, or `null` when the
 * platforms disagree — which a catalog editor must show rather than guess at.
 * Mirrors `ImageMetadata::common_user`.
 */
export function commonImageUser(metadata: ImageMetadata): string | undefined | null {
  const first = metadata.platforms[0]?.user
  return metadata.platforms.every((platform) => platform.user === first) ? first : null
}

/**
 * The `readFile` dependency `readEnvironmentDeclaration` expects, served from
 * one Host round trip.
 *
 * The resolver reads candidate paths one at a time and treats a not-found as
 * "try the next one", matched on the message (`NOT_FOUND` in
 * `./read-environment-declaration.ts`). This adapter answers from the set the
 * Host already returned, so the precedence walk costs no further calls and a
 * path the Host did not return reads as absent rather than as a failure.
 *
 * Over the byte limit, not UTF-8, or unreadable are all refusals from the Host
 * itself and reach the caller of `environmentDeclarationRead`, never here.
 */
export function declarationReader(
  result: DeclarationReadResult
): (root: string, relPath: string, maxBytes: number) => Promise<string> {
  const byPath = new Map(result.files.map((file) => [file.relativePath, file]))
  return async (_root, relPath, maxBytes) => {
    const file = byPath.get(relPath)
    if (!file) throw new Error(`${relPath}: no such file`)
    // The Host enforces its own ceiling; this one is the caller's, and a file
    // over it must refuse rather than be silently truncated.
    const byteLength = new TextEncoder().encode(file.contents).byteLength
    if (byteLength > maxBytes) {
      throw new Error(`${relPath} is ${byteLength} bytes, over the ${maxBytes} limit`)
    }
    return file.contents
  }
}

/** Every row of the catalog, with the deployment facts of its first page. */
export interface CatalogRows {
  /** The first page: the switch, floor, size classes and bundle offer are read from it. */
  facts: Omit<CatalogPage, "items" | "nextPageToken" | "rejected">
  rows: CatalogEntryRow[]
  rejected: CatalogRejectionRow[]
}

/**
 * Walk every catalog page.
 *
 * A bounded loop rather than a `while (token)` — a Host that kept issuing the
 * same token would otherwise spin forever in the run path.
 */
export async function fetchEnvironmentCatalogRows(pageSize = 200): Promise<CatalogRows> {
  const rejected: CatalogRejectionRow[] = []
  const first = await environmentCatalogList({ pageSize })
  const { items: _items, nextPageToken: _token, rejected: _rejected, ...facts } = first
  const rows = await collectPages(
    async (pageToken) => {
      const page =
        pageToken === undefined ? first : await environmentCatalogList({ pageSize, pageToken })
      rejected.push(...page.rejected)
      return page
    },
    { maxPages: 50, requireComplete: true }
  )
  return { facts, rows, rejected }
}

/**
 * The whole catalog as `resolveEnvironmentSpec` takes it.
 *
 * Pages until the Host stops issuing tokens, because resolution needs *every*
 * entry: the project's own may be on any page, and so may the default.
 */
export async function fetchEnvironmentCatalog(pageSize = 200): Promise<EnvironmentCatalogView> {
  const { facts: first, rows, rejected } = await fetchEnvironmentCatalogRows(pageSize)
  const entries: EnvironmentCatalogEntryView[] = rows.map((row) => ({
    id: row.entry.id,
    scope: row.entry.scope,
    label: row.entry.label,
    ...(row.entry.description === undefined ? {} : { description: row.entry.description }),
    image: row.entry.image,
    effectiveFloor: row.effectiveFloor,
    sizeClassIds: row.entry.sizeClassIds,
    ...(row.entry.imageUser === undefined ? {} : { imageUser: row.entry.imageUser }),
    source: row.entry.source,
  }))
  return {
    poolEnabled: first.poolEnabled,
    multiTenant: first.multiTenant,
    floor: first.floor,
    ...(first.defaultEntryId === undefined ? {} : { defaultEntryId: first.defaultEntryId }),
    entries,
    rejected,
    sizeClasses: first.sizeClasses,
    egressPresets: first.egressPresets,
    ...(first.bundle === undefined
      ? {}
      : {
          bundle: {
            current: {
              digest: first.bundle.current.digest,
              releaseTag: first.bundle.current.releaseTag,
            },
            retained: first.bundle.retained.map((bundle) => ({
              digest: bundle.digest,
              releaseTag: bundle.releaseTag,
            })),
          },
        }),
  }
}

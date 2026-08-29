export type SiteProvider = "cloudflare"

export type SiteLifecycle = "active" | "taken-down" | "deleting" | "deleted"

export type SiteExecutionTarget = { kind: "local" }

export interface SiteAuthoringPolicy {
  ownerAccountId: string
  editorAccountIds: string[]
  deployerAccountIds: string[]
}

export type SiteVisitorPolicy =
  | { mode: "private" }
  | { mode: "identities"; emails: string[] }
  | { mode: "domains"; domains: string[] }
  | { mode: "organization"; organizationId: string }
  | { mode: "public" }

export interface CloudflareSiteProviderConfig {
  accountId: string
  workerName: string
  zoneId?: string
  accessTeamName?: string
}

export interface SiteProjectRow {
  id: string
  name: string
  projectId: string
  sourceRoot: string
  sourceSubpath: string
  executionTarget: SiteExecutionTarget
  executionTargetKey: string
  provider: SiteProvider
  providerConfig: CloudflareSiteProviderConfig
  authoringPolicy: SiteAuthoringPolicy
  visitorPolicy: SiteVisitorPolicy
  lifecycle: SiteLifecycle
  createdAt: number
  updatedAt: number
}

/**
 * What to do with one secret when saving an environment revision.
 *
 * `saveEnvironment` replaces the whole variable set and rebuilt `secretRefs`
 * from only the newly typed secrets, while the editor could never seed itself
 * with values it cannot read back from the keyring. So changing a single
 * variable silently dropped every configured secret from the new revision, and
 * the deployed worker lost them on the next publish. Carrying a reference
 * forward is safe: `credentialId` is revision-scoped and old keyring entries
 * are never deleted, so an earlier revision stays redeployable too.
 */
export type SiteSecretEdit =
  /** Reuse the previous revision's reference verbatim. */
  | { key: string; action: "keep" }
  /** Store a new value under a new revision-scoped credential id. */
  | { key: string; action: "set"; value: string }
  /** Drop the key from the new revision. The old keyring entry stays. */
  | { key: string; action: "remove" }

export interface SiteSecretReference {
  key: string
  credentialId: string
  revision: string
}

export interface SiteEnvironmentRevisionRow {
  id: string
  siteId: string
  sequence: number
  variables: Record<string, string>
  secretRefs: SiteSecretReference[]
  createdAt: number
}

export interface SiteSourceSnapshot {
  commitSha: string
  dirty: boolean
  lockfileDigest: string
  inputDigest: string
}

export interface SiteBindingSnapshot {
  kind: "d1" | "r2" | "kv" | "service" | "analytics-engine"
  name: string
  resourceId?: string
}

export interface SiteBuildSnapshot {
  command: string
  runtime: string
  packageManager: string
  compatibilityDate: string
  compatibilityFlags: string[]
  routes: string[]
  bindings: SiteBindingSnapshot[]
}

export type SiteVersionStatus = "building" | "ready" | "failed"

export interface SiteVersionRow {
  id: string
  siteId: string
  sequence: number
  status: SiteVersionStatus
  environmentRevisionId: string
  source: SiteSourceSnapshot
  build: SiteBuildSnapshot
  artifactDigest?: string
  /**
   * Byte size of the archive at {@link artifactDigest}, denormalized at
   * completion.
   *
   * The size and file count live on the `siteArtifacts` row next to the archive
   * bytes, and Dexie has no column projection — reading that row structured-
   * clones the whole zip. The versions tab was pulling megabytes per version to
   * render two integers. Absent on rows written before v202.
   */
  artifactSize?: number
  /** File count of the archive at {@link artifactDigest}. See {@link artifactSize}. */
  artifactFileCount?: number
  /**
   * When retention deleted this version's archive bytes.
   *
   * The version stays `ready` — it really did build, and its provenance is
   * still the record ADR-0084 wants — but it can no longer be uploaded, so the
   * console says so rather than offering a button that fails on a missing
   * archive. See `lib/sites/artifact-gc.ts`.
   */
  artifactCollectedAt?: number
  failureMessage?: string
  createdAt: number
  completedAt?: number
}

export interface SiteArtifactRow {
  /** Lowercase SHA-256 digest of the exact immutable archive bytes. */
  digest: string
  bytes: Uint8Array
  mediaType: "application/gzip" | "application/zip"
  size: number
  fileCount: number
  createdAt: number
}

export type SiteDeploymentStatus =
  "pending" | "deploying" | "active" | "failed" | "superseded" | "taken-down"

export interface SiteDeploymentRow {
  id: string
  siteId: string
  versionId: string
  environmentRevisionId: string
  status: SiteDeploymentStatus
  providerDeploymentId?: string
  productionUrl?: string
  failureMessage?: string
  createdAt: number
  updatedAt: number
}

export type SiteOperationType =
  | "build"
  | "provision"
  | "upload"
  | "deploy"
  | "access"
  | "environment"
  | "domain"
  | "takedown"
  | "restore"
  | "reconcile"
  | "purge"

export type SiteOperationStatus =
  "queued" | "running" | "waiting-reconcile" | "succeeded" | "failed" | "cancelled"

export interface SiteOperationRow {
  id: string
  siteId: string
  type: SiteOperationType
  executionTargetKey: string
  idempotencyKey: string
  inputDigest: string
  /** Sanitized non-secret input used to reconcile uncertain provider outcomes. */
  inputPayload?: unknown
  status: SiteOperationStatus
  attemptCount: number
  leaseOwner?: string
  leaseExpiresAt?: number
  providerRequestId?: string
  errorMessage?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
}

/** The three stages a build passes through. */
export type SiteBuildPhase = "install" | "build" | "package"

export type SiteOperationEventType =
  | "queued"
  | "claimed"
  | "waiting-reconcile"
  | "succeeded"
  | "failed"
  | "cancelled"
  /**
   * Progress inside a running operation. A build is the only long operation in
   * the system, and until these existed a multi-minute one showed a spinner and
   * nothing else — `appendOperationEvent` fired only on lifecycle transitions.
   */
  | "phase-started"
  | "phase-succeeded"
  | "phase-failed"

export interface SiteOperationEventRow {
  id: string
  operationId: string
  sequence: number
  type: SiteOperationEventType
  message?: string
  providerRequestId?: string
  /** Set on the three `phase-*` types. Non-indexed. */
  phase?: SiteBuildPhase
  createdAt: number
}

/**
 * Captured output of one build phase.
 *
 * Its own table rather than a field on the version or a message on an event:
 * `listSiteVersions` is the console's hottest read and sits on the live-query
 * path, and `siteOperationEvents` is read to render a one-line sub-status.
 * Putting up to half a megabyte of build output in either would undo the work
 * that made those reads cheap. Here the bytes are read only when someone opens
 * the viewer.
 */
export interface SiteBuildLogRow {
  /** `${versionId}:${phase}` — one row per phase per version, rewritten on retry. */
  id: string
  versionId: string
  siteId: string
  operationId: string
  /** `package` spawns no process, so it never produces a row. */
  phase: Exclude<SiteBuildPhase, "package">
  argv: string[]
  exitCode: number
  durationSeconds: number
  timedOut: boolean
  /** The transport cap, the storage cap, or both, cut this output. */
  truncated: boolean
  stdout: string
  stderr: string
  /** Bytes actually stored after trimming, for the retention picture. */
  storedBytes: number
  createdAt: number
}

export type SiteResourceOwnership = "managed" | "adopted" | "shared"

export type SiteResourceKind =
  | "worker"
  | "worker-version"
  | "d1-database"
  | "r2-bucket"
  | "custom-domain"
  | "access-application"
  | "access-policy"
  | "secret"

export type SiteResourceStatus = "active" | "deleting" | "deleted" | "orphaned"

export interface SiteResourceRow {
  id: string
  siteId: string
  provider: SiteProvider
  kind: SiteResourceKind
  providerResourceId: string
  /** Human-readable provider name (for example a bucket name or hostname). */
  displayName?: string
  /** Non-secret provider metadata needed to reconcile or restore this relationship. */
  metadata?: Record<string, string>
  ownership: SiteResourceOwnership
  status: SiteResourceStatus
  dependencies: string[]
  createdAt: number
  updatedAt: number
}

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

export type SiteOperationEventType =
  "queued" | "claimed" | "waiting-reconcile" | "succeeded" | "failed" | "cancelled"

export interface SiteOperationEventRow {
  id: string
  operationId: string
  sequence: number
  type: SiteOperationEventType
  message?: string
  providerRequestId?: string
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

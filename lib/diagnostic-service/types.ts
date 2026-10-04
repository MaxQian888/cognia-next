/**
 * Wire types for the self-hosted diagnostic service (`services/diagnostic-server`).
 *
 * Hand-written against `services/diagnostic-server/openapi.yaml` rather than
 * generated: the service is a separate Cargo project with its own release
 * cadence and no codegen step in this repo's build. Keep the two in step — the
 * service has a drift test (`every_console_route_is_in_the_published_contract`)
 * that fails when a route leaves the contract, and this file is the other half
 * of that pairing.
 *
 * Every field name here is the camelCase serde projection of the Rust record;
 * nothing is renamed on the way in.
 */

/** Rungs of `GrantRole`, lowest first. A grant permits everything at or below. */
export const DIAGNOSTIC_ROLES = ["uploader", "viewer", "triager", "admin"] as const
export type DiagnosticRole = (typeof DIAGNOSTIC_ROLES)[number]

/** Whether `role` satisfies `required`, mirroring `GrantRole::permits`. */
export function rolePermits(role: DiagnosticRole, required: DiagnosticRole): boolean {
  return DIAGNOSTIC_ROLES.indexOf(role) >= DIAGNOSTIC_ROLES.indexOf(required)
}

/**
 * Client-side lifecycle, mirroring the `incident_state` enum, in lifecycle
 * order.
 *
 * This is the one vocabulary every surface speaks. `/logs` used to filter on a
 * camelCase `awaitingConsent` and had no `packaged` at all, so a report the
 * service (or the mobile plugin, which stores the service's own value) put in
 * either state matched no filter and rendered a missing-key placeholder.
 */
export const INCIDENT_CLIENT_STATES = [
  "detected",
  "packaged",
  "awaiting_consent",
  "queued",
  "uploading",
  "processing",
  "accepted",
  "rejected",
  "cancelled",
  "deleted",
] as const
export type IncidentClientState = (typeof INCIDENT_CLIENT_STATES)[number]

/**
 * States in which a captured report is still waiting on the user rather than
 * on the service: nothing has been sent, so the next move is theirs.
 */
export const ACTIONABLE_INCIDENT_STATES: readonly IncidentClientState[] = [
  "detected",
  "packaged",
  "awaiting_consent",
]

export function isIncidentClientState(value: unknown): value is IncidentClientState {
  return typeof value === "string" && (INCIDENT_CLIENT_STATES as readonly string[]).includes(value)
}

/**
 * Narrow an untrusted state string onto the service vocabulary.
 *
 * Accepts the camelCase spelling the UI used before it adopted the service's
 * (`awaitingConsent` → `awaiting_consent`), so a value persisted or written by
 * an older build still lands on a real state. Anything else returns `null`
 * and the caller decides what an unrecognized state means in its context —
 * there is no honest universal default.
 */
export function normalizeIncidentClientState(value: unknown): IncidentClientState | null {
  if (isIncidentClientState(value)) return value
  if (typeof value !== "string") return null
  const snake = value.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
  return isIncidentClientState(snake) ? snake : null
}

/** Server-side pipeline position, mirroring the `processing_state` enum. */
export const INCIDENT_PROCESSING_STATES = [
  "received",
  "scanning",
  "symbolicating",
  "grouping",
  "accepted",
  "retryable_failure",
  "permanent_failure",
  "deleted",
] as const
export type IncidentProcessingState = (typeof INCIDENT_PROCESSING_STATES)[number]

export function isIncidentProcessingState(value: unknown): value is IncidentProcessingState {
  return (
    typeof value === "string" && (INCIDENT_PROCESSING_STATES as readonly string[]).includes(value)
  )
}

export type GroupStatus = "open" | "suppressed" | "resolved"

/** Kinds `upload_parts.artifact_kind` accepts. */
export const ARTIFACT_KINDS = [
  "manifest",
  "events",
  "attachment",
  "minidump",
  "screenshot",
] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value)
}

/**
 * Every `audit_events.action` the service writes (`services/diagnostic-server
 * /src/db.rs`). Pinned so the console can translate each one; an action a
 * newer service adds renders as its raw code under a generic label rather
 * than as a missing-key placeholder.
 */
export const AUDIT_ACTIONS = [
  "alert.permanent_failure",
  "artifact.read",
  "consent.withdrawn",
  "group.triaged",
  "incident.accepted",
  "incident.cancelled",
  "incident.created",
  "incident.deleted",
  "incident.processing_failed",
  "incident.processing_queued",
  "incident.resumed",
  "retention.artifact_deleted",
  "retention.incident_deleted",
  "retention.permanent_failure",
  "symbol.indexed",
  "tenant.policy_changed",
  "tenant_key.created",
  "tenant_key.crypto_shredded",
  "tenant_key.rotated",
  "upload.part_rejected",
  "upload.part_stored",
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value)
}

export interface GrantResponse {
  grant: string
  role: DiagnosticRole
  expiresInSeconds: number
}

export interface IncidentRecord {
  id: string
  tenantId: string
  projectId: string
  installationId: string
  artifactHash: string
  buildId: string
  platform: string
  module: string
  exception: string
  clientState: IncidentClientState
  processingState: IncidentProcessingState
  supportCode: string
  fingerprint: string | null
  processingAttempts: number
  nextProcessingAt: string
  failureCode: string | null
  groupingBasis: unknown
  rawStack: unknown
  symbolizedStack: unknown
  missingSymbols: string[]
  groupId: string | null
  acceptedAt: string | null
  consentWithdrawnAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateIncidentResponse {
  incident: IncidentRecord
  /**
   * False when an identical `artifactHash` resumed an existing incident.
   *
   * Creation is idempotent on the artifact hash so a retried upload resumes
   * instead of duplicating, and the upsert deliberately leaves the stored
   * credential hash alone — which is why a resumed response carries no
   * credential at all rather than one that could never verify.
   */
  created: boolean
  /**
   * One-time credential, present only when `created` is true. The service
   * stores its SHA-256 and never shows it again, so a caller that drops it
   * cannot get it back — persist it beside the local report or lose the
   * ability to prove ownership of the submission later.
   */
  deletionCredential?: string
}

export interface UploadPartRecord {
  incidentId: string
  partNumber: number
  objectKey: string
  sourceSha256: string
  storedSha256: string
  storedBytes: number
  redactionVersion: string
  /** Field names the server's own privacy pass stripped after upload. */
  removedFields: string[]
  artifactKind: ArtifactKind
  createdAt: string
}

export interface UploadProgressResponse {
  incidentId: string
  parts: UploadPartRecord[]
  storedBytes: number
}

export interface IncidentGroupRecord {
  id: string
  projectId: string
  fingerprint: string
  fingerprintVersion: string
  status: GroupStatus
  assignedTo: string | null
  regressionCount: number
  compatibleBuildFamily: string
  platform: string
  exception: string
  module: string
  topFrames: unknown
  incidentCount: number
  firstSeenAt: string
  lastSeenAt: string
  createdAt: string
  updatedAt: string
}

export interface AuditEventRecord {
  id: number
  action: string
  incidentId: string | null
  /** The OIDC subject behind an operator action; null for worker actions. */
  actorId: string | null
  reason: string | null
  details: unknown
  occurredAt: string
}

export interface TenantRecord {
  id: string
  name: string
  retentionOverrides: Record<string, unknown>
  /** Gates raw minidump downloads. Off by default on every tenant. */
  rawMinidumpAccessEnabled: boolean
  createdAt: string
}

export interface SymbolRecord {
  id: string
  buildId: string
  platform: string
  objectKey: string
  relativePath: string
  symbolType: string
  status: string
  sha256: string
  createdAt: string
}

export interface CreateIncidentInput {
  artifactHash: string
  buildId: string
  platform: string
  module: string
  exception: string
  attachmentCount: number
  eventCount: number
  totalBytes: number
  largestAttachmentBytes: number
  largestMinidumpBytes: number
  /** The service refuses creation outright when this is false. */
  consent: boolean
}

export interface ListGroupsInput {
  status?: GroupStatus
  platform?: string
  assignedTo?: string
  /** Substring match over exception, module and fingerprint. */
  q?: string
  limit?: number
  offset?: number
}

export interface ListIncidentsInput {
  groupId?: string
  processingState?: IncidentProcessingState
  supportCode?: string
  limit?: number
  offset?: number
}

export interface TriageGroupInput {
  status?: GroupStatus
  /**
   * `undefined` leaves the assignee alone; `null` unassigns. The distinction is
   * carried all the way to the server, which discriminates an absent field from
   * an explicit null in its PATCH body.
   */
  assignedTo?: string | null
}

export interface UpdateTenantInput {
  rawMinidumpAccessEnabled?: boolean
  retentionOverrides?: Record<string, number>
}

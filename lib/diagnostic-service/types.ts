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

/** Client-side lifecycle, mirroring the `incident_state` enum. */
export type IncidentClientState =
  | "detected"
  | "packaged"
  | "awaiting_consent"
  | "queued"
  | "uploading"
  | "processing"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "deleted"

/** Server-side pipeline position, mirroring the `processing_state` enum. */
export type IncidentProcessingState =
  | "received"
  | "scanning"
  | "symbolicating"
  | "grouping"
  | "accepted"
  | "retryable_failure"
  | "permanent_failure"
  | "deleted"

export type GroupStatus = "open" | "suppressed" | "resolved"

/** Kinds `upload_parts.artifact_kind` accepts. */
export type ArtifactKind = "manifest" | "events" | "attachment" | "minidump" | "screenshot"

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

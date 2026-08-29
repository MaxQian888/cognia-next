export type SharedSessionStatus = "importing" | "active" | "archived" | "deleting"

export type SessionRole = "owner" | "maintainer" | "member" | "viewer"

export type SessionAction =
  | "session.discover"
  | "session.read"
  | "session.readHistory"
  | "session.post"
  | "session.startRun"
  | "session.steer"
  | "session.manageMembers"
  | "session.manageSettings"
  | "session.delete"
  | "message.correctOwn"
  | "message.redactOwn"
  | "message.redactAny"
  | "run.approveOrdinary"
  | "run.approveHighRisk"
  | "session.export"
  | "session.auditMetadata"
  | "session.breakGlassRead"
  | "attachment.read"
  | "attachment.write"

export type AuthorKind = "human" | "guest" | "agent" | "app" | "connector" | "system"

export interface AuthorRef {
  kind: AuthorKind
  id: string
  displayName?: string
  avatarUrl?: string
  /** Visible provenance for guests, apps, and connector-originated messages. */
  source?: string
}

export interface SharedSession {
  id: string
  orgId: string
  workspaceId: string
  title: string
  status: SharedSessionStatus
  createdBy: AuthorRef
  createdAt: number
  updatedAt: number
  revision: number
  policyRevision: number
}

export interface SessionMembership {
  sessionId: string
  userId: string
  role: SessionRole
  approver: boolean
  guest: boolean
  displayName?: string
  createdAt: number
  updatedAt: number
}

export type SessionInviteStatus = "pending" | "accepted" | "revoked" | "expired"

export interface SessionInvite {
  id: string
  sessionId: string
  role: Exclude<SessionRole, "owner">
  approver: boolean
  guest: boolean
  targetUserId?: string
  targetEmail?: string
  expiresAt: number
  status: SessionInviteStatus
  createdByUserId: string
  acceptedByUserId?: string
  acceptedAt?: number
  createdAt: number
}

export type SessionEventKind =
  | "message.created"
  | "message.corrected"
  | "message.redacted"
  | "member.joined"
  | "member.updated"
  | "member.removed"
  | "run.queued"
  | "run.started"
  | "run.steered"
  | "run.paused"
  | "run.completed"
  | "run.failed"
  | "approval.requested"
  | "approval.resolved"
  | "session.activated"
  | "session.archived"

export interface SessionEvent<TPayload = Record<string, unknown>> {
  id: string
  sessionId: string
  sequence: number
  kind: SessionEventKind
  actor: AuthorRef
  payload: TPayload
  createdAt: number
  operationId: string
}

export type RunLeaseStatus = "active" | "paused" | "released" | "expired" | "failed"

export interface RunLease {
  id: string
  sessionId: string
  runId: string
  holderUserId: string
  holderDeviceId: string
  status: RunLeaseStatus
  tokenExpiresAt: number
  heartbeatExpiresAt: number
  createdAt: number
  updatedAt: number
}

export interface RunQueueItem {
  id: string
  sessionId: string
  requestedByUserId: string
  payload: Record<string, unknown>
  status: "queued" | "claimed" | "cancelled"
  position: number
  createdAt: number
}

export type ApprovalRisk = "ordinary" | "high"
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled"

export interface ApprovalRequest {
  id: string
  sessionId: string
  runId: string
  action: string
  risk: ApprovalRisk
  requestedByUserId: string
  status: ApprovalStatus
  resolvedByUserId?: string
  resolvedAt?: number
  expiresAt: number
  createdAt: number
  revision: number
}

export type ChatAttachmentStatus = "pending" | "available" | "deleted"

export interface ChatAttachment {
  id: string
  sessionId: string
  eventId?: string
  fileName: string
  mediaType: string
  byteLength: number
  sha256: string
  status: ChatAttachmentStatus
  createdByUserId: string
  createdAt: number
  updatedAt: number
}

export interface BreakGlassGrant {
  id: string
  orgId: string
  sessionId: string
  grantedToUserId: string
  reason: string
  expiresAt: number
  revokedAt?: number
  createdAt: number
}

export interface AuthorizationDecision {
  allowed: boolean
  reason: string
  policyRevision: number
}

export interface AuthorizationAuditEvent {
  id: string
  orgId: string
  workspaceId?: string
  sessionId?: string
  actorUserId: string
  action: SessionAction | string
  resourceType: string
  resourceId: string
  allowed: boolean
  reason: string
  policyRevision: number
  createdAt: number
}

export interface ChatCollaborationBinding {
  orgId: string
  workspaceId: string
  sessionId: string
  policyRevision: number
  syncCursor: number
}

export interface MessageCollaborationMetadata {
  author: AuthorRef
  sourceEventId: string
  eventSequence: number
  version: number
  redactedAt?: number
  redactedBy?: AuthorRef
}

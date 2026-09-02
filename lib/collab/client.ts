/**
 * HTTP client for the collaboration plane (`crates/cognia-collab-server`).
 *
 * ADR-0149 §6 makes the server authoritative. Reads refresh local mirrors;
 * writes carry a stable operation id and an explicit base revision so retries
 * are idempotent and concurrent edits surface as conflicts instead of being
 * silently merged.
 *
 * # Two credentials, not one
 *
 * The Logto access token is what the *person* holds. The grant is what a
 * *request* carries, and it lives five minutes. `POST /v1/orgs/{org}/grants`
 * exchanges one for the other, and this client caches the result until shortly
 * before it expires — re-exchanging on every request would put a JWKS-verified
 * round trip in front of every board refresh.
 *
 * Shaped after `lib/diagnostic-service/client.ts`, which already solved
 * "bearer grant, injectable fetch, normalised base URL" for the other
 * tenant-scoped service. Same shape on purpose.
 */

import { normalizeServiceUrl } from "@/lib/diagnostic-service/client"

import type { CollabRunKind } from "@/lib/db/collab-run-mirror-types"
import type { PlanStatus } from "@/types/agent/plan"
import type { OrgRole, WorkspaceRole } from "@/types/identity"
import type { IssuePriority, IssueRunArtifact, IssueRunStatus, IssueStatus } from "@/types/issues"
import type { CollabIssueActor } from "@/types/issues/collab"
import type {
  ApprovalRequest,
  AuthorizationAuditEvent,
  BreakGlassGrant,
  ChatAttachment,
  RunLease,
  RunQueueItem,
  SessionEvent,
  SessionInvite,
  SessionMembership,
  SessionRole,
  SharedSession,
} from "@cognia/agent-config-types"

/** One issue as the collaboration plane returns it. */
export interface CollabIssue {
  id: string
  orgId: string
  workspaceId: string
  issueProjectId: string
  title: string
  body?: string
  status: IssueStatus
  priority: IssuePriority
  boardOrder: number
  assignee?: CollabIssueActor
  createdBy: CollabIssueActor
  createdAt: number
  updatedAt: number
  revision?: number
  createdOperationId?: string
  lastOperationId?: string
}

export interface CollabIssueEvent {
  id: string
  issueId: string
  kind: string
  ts: number
  actor: CollabIssueActor
  payload?: unknown
}

/**
 * What the caller holds in one org, as the server reports it.
 *
 * Raw facts only. Whether this describes a guest — no org role, at least one
 * workspace — is derived by `personStandingFrom`, and the server deliberately
 * does not state it: two implementations of one rule is one too many.
 */
export interface CollabMemberships {
  userId: string
  orgId: string
  orgRole?: OrgRole
  workspaces: { workspaceId: string; role: WorkspaceRole }[]
}

/** A workspace as the plane knows it — ADR-0149 §6. */
export interface CollabWorkspace {
  /** The local `projectId`, unchanged. */
  id: string
  orgId: string
  name: string
  createdAt: number
  updatedAt: number
}

/**
 * One seat in a workspace.
 *
 * `orgMember` is the raw fact, not a verdict: whether this person is a guest
 * is `personStandingFrom`'s answer, and the server deliberately does not give
 * a second one.
 */
export interface CollabWorkspaceMember {
  userId: string
  displayName: string
  role: WorkspaceRole
  orgMember: boolean
}

export interface CollabHealth {
  status: string
  collabProtocolVersion?: number
  features?: string[]
}

/**
 * One plan as the plane knows it — ADR-0149 §6.
 *
 * `steps` is present only on a single-plan read. The listing omits it, and
 * `undefined` here means "not asked for" rather than "there are none": a panel
 * that read an empty array would render every plan as having no work in it.
 */
export interface CollabPlan {
  id: string
  orgId: string
  workspaceId: string
  title: string
  description?: string
  status: PlanStatus
  /** Recomputed server-side from the steps; never a number a client stated. */
  totalSteps: number
  completedSteps: number
  createdBy: CollabIssueActor
  createdAt: number
  updatedAt: number
  endedAt?: number
  steps?: CollabPlanStep[]
  revision?: number
  createdOperationId?: string
  lastOperationId?: string
}

export interface CollabPlanStep {
  id: string
  planId: string
  order: number
  title: string
  description?: string
  kind: string
  status: string
  result?: string
  error?: string
  startedAt?: number
  completedAt?: number
}

/** One dispatch as the plane knows it. */
export interface CollabRun {
  id: string
  orgId: string
  workspaceId: string
  /** Both optional: an ad-hoc dispatch attaches to nothing. */
  issueId?: string
  planId?: string
  title: string
  kind: CollabRunKind
  status: IssueRunStatus
  startedBy: CollabIssueActor
  startedAt: number
  updatedAt: number
  endedAt?: number
  summary?: string
  error?: string
  /** Always http(s) — the server refuses anything else. */
  artifacts?: IssueRunArtifact[]
  revision?: number
  createdOperationId?: string
  lastOperationId?: string
}

export interface CreateCollabIssueInput {
  operationId: string
  workspaceId: string
  issueProjectId: string
  title: string
  body?: string
  status?: IssueStatus
  priority?: IssuePriority
  boardOrder?: number
  assignee?: CollabIssueActor
}

export type PatchCollabIssueInput = {
  operationId: string
  baseRevision: number
} & Partial<Pick<CollabIssue, "title" | "body" | "status" | "priority" | "boardOrder" | "assignee">>

export interface AppendCollabIssueEventInput {
  operationId: string
  kind: string
  payload?: unknown
}

export type CreateCollabPlanInput = Record<string, unknown> & {
  operationId: string
  workspaceId: string
  title: string
}

export type PatchCollabPlanInput = Record<string, unknown> & {
  operationId: string
  baseRevision: number
}

export type CreateCollabRunInput = Record<string, unknown> & {
  operationId: string
  workspaceId: string
  title: string
}

export type PatchCollabRunInput = Record<string, unknown> & {
  operationId: string
  baseRevision: number
}

interface MintedGrant {
  grant: string
  userId: string
  orgId: string
  /** Unix seconds, from the server's clock. */
  expiresAt: number
}

export type CollabFetch = (input: string, init?: RequestInit) => Promise<Response>

export class CollabError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "CollabError"
  }

  /** True when re-exchanging the grant might help. */
  get isExpiredCredential(): boolean {
    return this.status === 401
  }
}

export class CollabConflictError<T = unknown> extends CollabError {
  constructor(
    message: string,
    readonly authoritative: T
  ) {
    super(409, message)
    this.name = "CollabConflictError"
  }
}

export interface CollabClientOptions {
  baseUrl: string
  /** The Logto access token for this person. Called per exchange, so a refreshed token is picked up. */
  accessToken: () => Promise<string | null>
  fetchImpl: CollabFetch
  /** Injectable so the grant cache can be tested without waiting. */
  now?: () => number
  /** Injectable so realtime behavior can be verified outside a browser. */
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket
}

export interface CollabIdentity {
  userId: string
  orgId: string
}

/** One org the signed-in subject holds standing in, from `GET /v1/account/memberships`. */
export interface CollabAccountMembership {
  orgId: string
  orgName: string
  logtoOrganizationId?: string
  /** The canonical `usr_…` in that org. Never derived locally. */
  userId: string
  orgRole?: "owner" | "admin" | "member"
  workspaceCount: number
}

export interface CollabAccountMemberships {
  subject: string
  memberships: CollabAccountMembership[]
}

export interface BootstrapCollabAccountInput {
  /** Client-minted and replayed verbatim on retry. The server resumes by it. */
  operationId: string
  credential: string
  orgName: string
  displayName?: string
  email?: string
}

export interface BootstrappedCollabAccount {
  operationId: string
  orgId: string
  userId: string
  logtoOrganizationId: string
}

export interface AcceptCollabInvitationInput {
  operationId: string
  token: string
  displayName?: string
}

export interface AcceptedCollabInvitation {
  operationId: string
  orgId: string
  userId: string
  logtoOrganizationId: string
  invitationId: string
}

/**
 * Re-exchange this many milliseconds before the grant actually expires.
 *
 * A grant that expires mid-flight produces a 401 the caller has to recover
 * from; spending one extra exchange to avoid that is the cheaper trade.
 */
const GRANT_REFRESH_MARGIN_MS = 30_000
export const SHARED_CHAT_PROTOCOL_VERSION = "2"

// ── Membership administration (ADR-0149 section 4) ─────────────────────────

export interface CollabInvitation {
  id: string
  orgId: string
  workspaceId?: string
  orgRole?: OrgRole
  workspaceRole?: WorkspaceRole
  createdBy: string
  expiresAt: number
  redeemedAt?: number
  redeemedBy?: string
  revokedAt?: number
  createdAt: number
}

/** The create answer. `token` is returned exactly once and never stored. */
export interface IssuedCollabInvitation extends CollabInvitation {
  token: string
}

export interface CreateCollabInvitationInput {
  orgRole?: OrgRole
  workspaceId?: string
  workspaceRole?: WorkspaceRole
  /** The server defaults to 7. */
  expiresInDays?: number
  reason: string
}

/**
 * One row of the org's membership audit. Not the session audit
 * (`AuthorizationAuditEvent`): that one records allow/deny decisions on a
 * shared chat, this one records who changed whose standing and why.
 */
export interface CollabMembershipAuditEvent {
  id: string
  orgId: string
  workspaceId?: string
  actorUserId: string
  targetUserId?: string
  invitationId?: string
  /** e.g. `invitation.created`, `org.member.role`, `workspace.member.removed`. */
  action: string
  oldRole?: string
  newRole?: string
  reason: string
  requestId: string
  grantId?: string
  createdAt: number
}

export interface SetCollabOrgMemberRoleInput {
  role: OrgRole
  reason: string
}

export interface SetCollabWorkspaceMemberInput {
  role: WorkspaceRole
  reason: string
}

/**
 * `x-cognia-reason` travels as a header, and header values are ASCII. A reason
 * written in another script goes RFC 8187 style, `UTF-8''` plus percent
 * encoding, which the server decodes before the audit row is written. A plain
 * ASCII reason is sent as it is, so the common case stays readable on the wire.
 */
export function encodeReasonHeader(reason: string): string {
  const trimmed = reason.trim()
  // Visible ASCII only. Anything else would make `fetch` refuse the header.
  return /^[ -~]*$/.test(trimmed) ? trimmed : `UTF-8''${encodeURIComponent(trimmed)}`
}

function reasonHeaders(reason?: string): Record<string, string> {
  const value = reason?.trim()
  return value ? { "x-cognia-reason": encodeReasonHeader(value) } : {}
}

export class CollabClient {
  private readonly baseUrl: string
  private readonly accessToken: () => Promise<string | null>
  private readonly fetchImpl: CollabFetch
  private readonly now: () => number
  private readonly webSocketFactory: (url: string, protocols: string[]) => WebSocket
  /** Cached per org: a grant is scoped to one, so one slot would thrash. */
  private readonly grants = new Map<string, MintedGrant>()

  constructor(options: CollabClientOptions) {
    this.baseUrl = normalizeServiceUrl(options.baseUrl)
    this.accessToken = options.accessToken
    this.fetchImpl = options.fetchImpl
    this.now = options.now ?? (() => Date.now())
    this.webSocketFactory =
      options.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols))
  }

  /** Drop a cached grant, e.g. after signing out. */
  forgetGrant(orgId?: string): void {
    if (orgId === undefined) this.grants.clear()
    else this.grants.delete(orgId)
  }

  /** Resolve the server-owned person id without exposing the bearer grant. */
  async identity(orgId: string): Promise<CollabIdentity> {
    await this.grantFor(orgId)
    const minted = this.grants.get(orgId)
    if (!minted) throw new CollabError(401, "collaboration identity is unavailable")
    return { userId: minted.userId, orgId: minted.orgId }
  }

  // ── Account control plane ───────────────────────────────────────────────
  //
  // These three take the Logto access token DIRECTLY rather than a grant: a
  // grant is scoped to an org, and each of these runs before the person has
  // one. They are the only routes that do.

  /** Every org this subject belongs to, with the canonical `usr_` in each. */
  async accountMemberships(): Promise<CollabAccountMemberships> {
    return this.withAccessToken<CollabAccountMemberships>("/v1/account/memberships")
  }

  /**
   * Claim the deployment with the one-time bootstrap credential. Replaying
   * the same `operationId` after a failure resumes the server-side saga
   * instead of starting a second one.
   */
  async bootstrapAccount(input: BootstrapCollabAccountInput): Promise<BootstrappedCollabAccount> {
    return this.withAccessToken<BootstrappedCollabAccount>("/v1/account/bootstrap", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  /** Redeem an opaque invitation token with a plain (organization-less) session. */
  async acceptInvitationByToken(
    input: AcceptCollabInvitationInput
  ): Promise<AcceptedCollabInvitation> {
    return this.withAccessToken<AcceptedCollabInvitation>("/v1/invitations/accept", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  /** Feature probe. A legacy plain-text `ok` response means read-only protocol 0. */
  async health(): Promise<CollabHealth> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`)
    if (!response.ok)
      throw new CollabError(response.status, `collaboration plane returned ${response.status}`)
    const text = await response.text()
    if (text.trim() === "ok") return { status: "ok", collabProtocolVersion: 0, features: [] }
    return JSON.parse(text) as CollabHealth
  }

  async listIssues(
    orgId: string,
    query: { workspaceId?: string; issueProjectId?: string; assigneeId?: string } = {}
  ): Promise<CollabIssue[]> {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value) search.set(key, value)
    }
    const suffix = search.toString() ? `?${search}` : ""
    return this.json<CollabIssue[]>(orgId, `/v1/orgs/${encodeURIComponent(orgId)}/issues${suffix}`)
  }

  /**
   * What this person holds in `orgId`.
   *
   * Not scoped to a workspace, and it must not be: asking which workspaces you
   * belong to cannot require belonging to one.
   */
  async myMemberships(orgId: string): Promise<CollabMemberships> {
    return this.json<CollabMemberships>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/memberships/me`
    )
  }

  /** Workspaces this person can see in `orgId`, narrowed by the server. */
  async listWorkspaces(orgId: string): Promise<CollabWorkspace[]> {
    return this.json<CollabWorkspace[]>(orgId, `/v1/orgs/${encodeURIComponent(orgId)}/workspaces`)
  }

  /** Everyone in one workspace. Requires read access to it, not just its id. */
  async listWorkspaceMembers(orgId: string, workspaceId: string): Promise<CollabWorkspaceMember[]> {
    return this.json<CollabWorkspaceMember[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/members`
    )
  }

  // ── Membership administration ──────────────────────────────────────────
  //
  // Every one of these mutates rows the local projection mirrors. The caller
  // (`lib/collab/membership-admin.ts`) follows each with a refresh, and
  // nothing here writes locally.

  /** Mint a one-time invitation. The token in the answer is shown once. */
  async createInvitation(
    orgId: string,
    input: CreateCollabInvitationInput
  ): Promise<IssuedCollabInvitation> {
    return this.json<IssuedCollabInvitation>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/invitations`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  /**
   * The org's invitations, newest first. Owners and admins see all of them,
   * anybody else the ones they minted. The server narrows, not the client.
   */
  async listInvitations(orgId: string): Promise<CollabInvitation[]> {
    return this.json<CollabInvitation[]>(orgId, `/v1/orgs/${encodeURIComponent(orgId)}/invitations`)
  }

  async revokeInvitation(
    orgId: string,
    invitationId: string,
    reason?: string
  ): Promise<CollabInvitation> {
    return this.json<CollabInvitation>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE", headers: reasonHeaders(reason) }
    )
  }

  /** Change somebody's org role. Owners and admins only, decided by the server. */
  async setOrgMemberRole(
    orgId: string,
    userId: string,
    input: SetCollabOrgMemberRoleInput
  ): Promise<void> {
    await this.json<unknown>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    )
  }

  /**
   * Remove every standing the person holds in the org: membership, workspace
   * seats, and the invitations they minted. One server transaction.
   */
  async offboardOrgMember(orgId: string, userId: string, reason?: string): Promise<void> {
    await this.json<unknown>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE", headers: reasonHeaders(reason) }
    )
  }

  /** Seat somebody in a workspace, or change the seat they hold. */
  async setWorkspaceMember(
    orgId: string,
    workspaceId: string,
    userId: string,
    input: SetCollabWorkspaceMemberInput
  ): Promise<void> {
    await this.json<unknown>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async removeWorkspaceMember(
    orgId: string,
    workspaceId: string,
    userId: string,
    reason?: string
  ): Promise<void> {
    await this.json<unknown>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE", headers: reasonHeaders(reason) }
    )
  }

  /** The org's authorization audit, newest first. Org management only. */
  async listAuthorizationAudit(orgId: string, limit = 100): Promise<CollabMembershipAuditEvent[]> {
    return this.json<CollabMembershipAuditEvent[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/audit-events?limit=${Math.max(1, Math.min(limit, 500))}`
    )
  }

  async listSharedSessions(orgId: string, workspaceId: string): Promise<SharedSession[]> {
    return this.json<SharedSession[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/chat-sessions`
    )
  }

  async createSharedSession(
    orgId: string,
    workspaceId: string,
    input: { title: string; operationId: string; importing?: boolean }
  ): Promise<SharedSession> {
    return this.json<SharedSession>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/chat-sessions`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async getSharedSession(orgId: string, sessionId: string): Promise<SharedSession> {
    return this.json<SharedSession>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}`
    )
  }

  async updateSharedSession(
    orgId: string,
    sessionId: string,
    input: {
      title?: string
      status?: SharedSession["status"]
      operationId: string
      baseRevision: number
    }
  ): Promise<SharedSession> {
    return this.json<SharedSession>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    )
  }

  async deleteSharedSession(
    orgId: string,
    sessionId: string,
    input: { operationId: string; baseRevision: number }
  ): Promise<void> {
    const query = new URLSearchParams({
      operationId: input.operationId,
      baseRevision: String(input.baseRevision),
    })
    await this.json<void>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}?${query}`,
      { method: "DELETE" }
    )
  }

  async listSessionMembers(orgId: string, sessionId: string): Promise<SessionMembership[]> {
    return this.json<SessionMembership[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/members`
    )
  }

  async putSessionMember(
    orgId: string,
    sessionId: string,
    input: { userId: string; role: SessionRole; approver?: boolean; guest?: boolean }
  ): Promise<SessionMembership> {
    return this.json<SessionMembership>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/members`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async updateSessionMember(
    orgId: string,
    sessionId: string,
    userId: string,
    input: { role: SessionRole; approver?: boolean; guest?: boolean }
  ): Promise<SessionMembership> {
    return this.json<SessionMembership>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    )
  }

  async removeSessionMember(orgId: string, sessionId: string, userId: string): Promise<void> {
    await this.json<unknown>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    )
  }

  async listSessionInvites(orgId: string, sessionId: string): Promise<SessionInvite[]> {
    return this.json<SessionInvite[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/invites`
    )
  }

  async createSessionInvite(
    orgId: string,
    sessionId: string,
    input: {
      targetUserId?: string
      role: Exclude<SessionRole, "owner">
      approver?: boolean
      guest?: boolean
      expiresAt: number
    }
  ): Promise<{ invite: SessionInvite; token: string }> {
    return this.json<{ invite: SessionInvite; token: string }>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/invites`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async acceptSessionInvite(
    orgId: string,
    token: string
  ): Promise<{ invite: SessionInvite; membership: SessionMembership }> {
    return this.json<{ invite: SessionInvite; membership: SessionMembership }>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-invites/accept`,
      { method: "POST", body: JSON.stringify({ token }) }
    )
  }

  async revokeSessionInvite(
    orgId: string,
    sessionId: string,
    inviteId: string
  ): Promise<SessionInvite> {
    return this.json<SessionInvite>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/invites/${encodeURIComponent(inviteId)}`,
      { method: "DELETE" }
    )
  }

  async listSessionEvents(
    orgId: string,
    sessionId: string,
    afterSequence = 0
  ): Promise<SessionEvent[]> {
    return this.json<SessionEvent[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/events?afterSequence=${afterSequence}`
    )
  }

  async appendSessionEvent(
    orgId: string,
    sessionId: string,
    input: {
      id?: string
      kind: "message.created" | "message.corrected" | "message.redacted" | "run.steered"
      payload: Record<string, unknown>
      operationId: string
      actorLabel?: string
    }
  ): Promise<SessionEvent> {
    return this.json<SessionEvent>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/events`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async openSessionStream(orgId: string, sessionId: string): Promise<WebSocket> {
    const { ticket } = await this.json<{ ticket: string; expiresAt: number }>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/stream-tickets`,
      { method: "POST", body: "{}" }
    )
    const url = new URL(
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/stream`,
      this.baseUrl
    )
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    return this.webSocketFactory(url.toString(), ["cognia.chat.v1", ticket])
  }

  async acquireSessionRunLease(
    orgId: string,
    sessionId: string,
    input: { runId: string; deviceId: string; operationId: string }
  ): Promise<{ lease: RunLease; token: string }> {
    return this.json<{ lease: RunLease; token: string }>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/run-leases`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async getActiveSessionRunLease(orgId: string, sessionId: string): Promise<RunLease | null> {
    return this.json<RunLease | null>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/run-leases`
    )
  }

  async heartbeatSessionRunLease(
    orgId: string,
    sessionId: string,
    leaseId: string,
    input: { deviceId: string; token: string }
  ): Promise<RunLease> {
    return this.json<RunLease>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/run-leases/${encodeURIComponent(leaseId)}/heartbeat`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async releaseSessionRunLease(
    orgId: string,
    sessionId: string,
    leaseId: string,
    status: "released" | "failed" = "released"
  ): Promise<RunLease> {
    return this.json<RunLease>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/run-leases/${encodeURIComponent(leaseId)}?status=${status}`,
      { method: "DELETE" }
    )
  }

  async listSessionRunQueue(orgId: string, sessionId: string): Promise<RunQueueItem[]> {
    return this.json<RunQueueItem[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/queue`
    )
  }

  async listSessionAuthorizationAudit(
    orgId: string,
    sessionId: string,
    limit = 200
  ): Promise<AuthorizationAuditEvent[]> {
    return this.json<AuthorizationAuditEvent[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/audit?limit=${Math.max(1, Math.min(limit, 500))}`
    )
  }

  async createSessionBreakGlassGrant(
    orgId: string,
    sessionId: string,
    input: { reason: string; durationMs: number; operationId: string }
  ): Promise<BreakGlassGrant> {
    return this.json<BreakGlassGrant>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/break-glass`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async listSessionBreakGlassEvents(
    orgId: string,
    sessionId: string,
    grantId: string,
    afterSequence = 0,
    limit = 200
  ): Promise<SessionEvent[]> {
    return this.json<SessionEvent[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/break-glass/${encodeURIComponent(grantId)}/events?afterSequence=${afterSequence}&limit=${Math.max(1, Math.min(limit, 500))}`
    )
  }

  async enqueueSessionRunInput(
    orgId: string,
    sessionId: string,
    input: { payload: Record<string, unknown>; operationId: string }
  ): Promise<RunQueueItem> {
    return this.json<RunQueueItem>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/queue`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async cancelSessionRunQueueItem(
    orgId: string,
    sessionId: string,
    itemId: string
  ): Promise<RunQueueItem> {
    return this.json<RunQueueItem>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`,
      { method: "DELETE" }
    )
  }

  async steerSessionRun(
    orgId: string,
    sessionId: string,
    input: { runId: string; payload: Record<string, unknown>; operationId: string }
  ): Promise<SessionEvent> {
    return this.json<SessionEvent>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/steer`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async appendSessionRunEvent(
    orgId: string,
    sessionId: string,
    runId: string,
    token: string,
    input: {
      kind: "message.created" | "run.started" | "run.paused" | "run.completed" | "run.failed"
      payload: Record<string, unknown>
      operationId: string
    }
  ): Promise<SessionEvent> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cognia-collab-protocol": SHARED_CHAT_PROTOCOL_VERSION,
          "x-cognia-run-token": token,
        },
        body: JSON.stringify(input),
      }
    )
    return readJson<SessionEvent>(response)
  }

  async listSessionApprovals(orgId: string, sessionId: string): Promise<ApprovalRequest[]> {
    return this.json<ApprovalRequest[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/approvals`
    )
  }

  async createSessionApproval(
    orgId: string,
    sessionId: string,
    input: {
      runId: string
      action: string
      risk: ApprovalRequest["risk"]
      expiresAt: number
      operationId: string
    }
  ): Promise<ApprovalRequest> {
    return this.json<ApprovalRequest>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/approvals`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async resolveSessionApproval(
    orgId: string,
    sessionId: string,
    approvalId: string,
    input: { status: "approved" | "denied"; baseRevision: number }
  ): Promise<ApprovalRequest> {
    return this.json<ApprovalRequest>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    )
  }

  async initializeSessionAttachment(
    orgId: string,
    sessionId: string,
    input: { fileName: string; mediaType: string; byteLength: number; sha256: string }
  ): Promise<{ attachment: ChatAttachment; ticket: string; expiresAt: number }> {
    return this.json<{ attachment: ChatAttachment; ticket: string; expiresAt: number }>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/attachments`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  async uploadSessionAttachment(
    orgId: string,
    attachmentId: string,
    ticket: string,
    body: Blob | ArrayBuffer | Uint8Array
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/orgs/${encodeURIComponent(orgId)}/chat-attachment-objects/${encodeURIComponent(attachmentId)}`,
      {
        method: "PUT",
        headers: {
          "x-cognia-attachment-ticket": ticket,
          "x-cognia-collab-protocol": SHARED_CHAT_PROTOCOL_VERSION,
        },
        body: body as BodyInit,
      }
    )
    if (!response.ok) throw await responseError(response)
  }

  async commitSessionAttachment(
    orgId: string,
    sessionId: string,
    attachmentId: string,
    eventId?: string
  ): Promise<ChatAttachment> {
    return this.json<ChatAttachment>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/commit`,
      { method: "POST", body: JSON.stringify({ eventId }) }
    )
  }

  async createSessionAttachmentDownloadTicket(
    orgId: string,
    sessionId: string,
    attachmentId: string
  ): Promise<{ attachment: ChatAttachment; ticket: string; expiresAt: number }> {
    return this.json<{ attachment: ChatAttachment; ticket: string; expiresAt: number }>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/download-ticket`,
      { method: "POST", body: "{}" }
    )
  }

  async downloadSessionAttachment(
    orgId: string,
    attachmentId: string,
    ticket: string
  ): Promise<Blob> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/orgs/${encodeURIComponent(orgId)}/chat-attachment-objects/${encodeURIComponent(attachmentId)}`,
      {
        headers: {
          "x-cognia-attachment-ticket": ticket,
          "x-cognia-collab-protocol": SHARED_CHAT_PROTOCOL_VERSION,
        },
      }
    )
    if (!response.ok) throw await responseError(response)
    return response.blob()
  }

  async deleteSessionAttachment(
    orgId: string,
    sessionId: string,
    attachmentId: string
  ): Promise<void> {
    await this.json<unknown>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/chat-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" }
    )
  }

  /** Plans this person can see in `orgId`, headers only, newest activity first. */
  async listPlans(
    orgId: string,
    query: { workspaceId?: string; status?: PlanStatus } = {}
  ): Promise<CollabPlan[]> {
    return this.json<CollabPlan[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/plans${searchSuffix(query)}`
    )
  }

  /**
   * One plan WITH its steps.
   *
   * Not called by the refresh: the mirror stores headers, and fetching every
   * plan's steps on every pull would be one request each to fill a detail view
   * that does not exist yet. This is the seam that view will use.
   */
  async getPlan(orgId: string, planId: string): Promise<CollabPlan> {
    return this.json<CollabPlan>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/plans/${encodeURIComponent(planId)}`
    )
  }

  /** Runs in `orgId`, most recently started first. */
  async listRuns(
    orgId: string,
    query: { workspaceId?: string; issueId?: string; planId?: string; active?: boolean } = {}
  ): Promise<CollabRun[]> {
    return this.json<CollabRun[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/runs${searchSuffix(query)}`
    )
  }

  async listEvents(orgId: string, issueId: string): Promise<CollabIssueEvent[]> {
    return this.json<CollabIssueEvent[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/issues/${encodeURIComponent(issueId)}/events`
    )
  }

  createIssue(orgId: string, input: CreateCollabIssueInput): Promise<CollabIssue> {
    return this.json(orgId, `/v1/orgs/${encodeURIComponent(orgId)}/issues`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  patchIssue(orgId: string, issueId: string, input: PatchCollabIssueInput): Promise<CollabIssue> {
    return this.json(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/issues/${encodeURIComponent(issueId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    )
  }

  appendIssueEvent(
    orgId: string,
    issueId: string,
    input: AppendCollabIssueEventInput
  ): Promise<CollabIssueEvent> {
    return this.json(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/issues/${encodeURIComponent(issueId)}/events`,
      { method: "POST", body: JSON.stringify(input) }
    )
  }

  createPlan(orgId: string, input: CreateCollabPlanInput): Promise<CollabPlan> {
    return this.json(orgId, `/v1/orgs/${encodeURIComponent(orgId)}/plans`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  patchPlan(orgId: string, planId: string, input: PatchCollabPlanInput): Promise<CollabPlan> {
    return this.json(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/plans/${encodeURIComponent(planId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    )
  }

  createRun(orgId: string, input: CreateCollabRunInput): Promise<CollabRun> {
    return this.json(orgId, `/v1/orgs/${encodeURIComponent(orgId)}/runs`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  patchRun(orgId: string, runId: string, input: PatchCollabRunInput): Promise<CollabRun> {
    return this.json(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/runs/${encodeURIComponent(runId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    )
  }

  /**
   * Exchange the access token for a grant, reusing a cached one until it is
   * close to expiry.
   */
  private async grantFor(orgId: string): Promise<string> {
    const cached = this.grants.get(orgId)
    if (cached && cached.expiresAt * 1000 - GRANT_REFRESH_MARGIN_MS > this.now()) {
      return cached.grant
    }

    const token = await this.accessToken()
    if (!token) {
      // Not an error state: a profile nobody has signed in on simply has no
      // collaboration plane, and the board shows its local issues.
      throw new CollabError(401, "not signed in")
    }

    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/orgs/${encodeURIComponent(orgId)}/grants`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      }
    )
    const minted = await readJson<MintedGrant>(response)
    this.grants.set(orgId, minted)
    return minted.grant
  }

  /** A request authenticated by the Logto access token itself, not a grant. */
  private async withAccessToken<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken()
    if (!token) throw new CollabError(401, "not signed in")
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
        "x-cognia-collab-protocol": SHARED_CHAT_PROTOCOL_VERSION,
        authorization: `Bearer ${token}`,
      },
    })
    return readJson<T>(response)
  }

  private async json<T>(orgId: string, path: string, init: RequestInit = {}): Promise<T> {
    const attempt = async (grant: string) =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
          "x-cognia-collab-protocol": SHARED_CHAT_PROTOCOL_VERSION,
          authorization: `Bearer ${grant}`,
        },
      })

    let response = await attempt(await this.grantFor(orgId))
    if (response.status === 401) {
      // The cached grant expired against the server's clock rather than ours —
      // clock skew, or a restart that rotated the signing key. One retry with a
      // fresh grant, then the error stands.
      this.grants.delete(orgId)
      response = await attempt(await this.grantFor(orgId))
    }
    return readJson<T>(response)
  }
}

/**
 * Build a `?a=b` suffix, dropping absent and falsy values.
 *
 * `false` is dropped along with `undefined` on purpose: every boolean here is
 * a narrowing flag, and `?active=false` and no flag at all mean the same thing
 * to the server. Sending the former would just be a longer way to ask.
 */
function searchSuffix(query: Record<string, string | boolean | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === false || value === "") continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await readErrorBody(response)
    const message =
      typeof body?.error === "string" && body.error
        ? body.error
        : `collaboration plane returned ${response.status}`
    if (response.status === 409 && body && "authoritative" in body) {
      throw new CollabConflictError(message, body.authoritative)
    }
    throw new CollabError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function responseError(response: Response): Promise<CollabError> {
  const body = await readErrorBody(response)
  const message =
    typeof body?.error === "string" && body.error
      ? body.error
      : `collaboration plane returned ${response.status}`
  return new CollabError(response.status, message)
}

async function readErrorBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await response.json()) as unknown
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null
  } catch {
    // A non-JSON body (a proxy's HTML error page) is not worth a second failure.
    return null
  }
}

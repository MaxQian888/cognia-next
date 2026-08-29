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
  RunLease,
  SessionEvent,
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

/**
 * Re-exchange this many milliseconds before the grant actually expires.
 *
 * A grant that expires mid-flight produces a 401 the caller has to recover
 * from; spending one extra exchange to avoid that is the cheaper trade.
 */
const GRANT_REFRESH_MARGIN_MS = 30_000

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

  private async json<T>(orgId: string, path: string, init: RequestInit = {}): Promise<T> {
    const attempt = async (grant: string) =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
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

async function readErrorBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await response.json()) as unknown
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null
  } catch {
    // A non-JSON body (a proxy's HTML error page) is not worth a second failure.
    return null
  }
}

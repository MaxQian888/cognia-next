/**
 * HTTP client for the collaboration plane (`crates/cognia-collab-server`).
 *
 * ADR-0149 §6 makes the server authoritative and the client a read-only cache,
 * so this module only ever reads. Writes land in a later cut; adding them now
 * would mean inventing a conflict story for rows the client does not own.
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

import type { OrgRole, WorkspaceRole } from "@/types/identity"
import type { IssuePriority, IssueStatus } from "@/types/issues"
import type { CollabIssueActor } from "@/types/issues/collab"

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

export interface CollabClientOptions {
  baseUrl: string
  /** The Logto access token for this person. Called per exchange, so a refreshed token is picked up. */
  accessToken: () => Promise<string | null>
  fetchImpl: CollabFetch
  /** Injectable so the grant cache can be tested without waiting. */
  now?: () => number
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
  /** Cached per org: a grant is scoped to one, so one slot would thrash. */
  private readonly grants = new Map<string, MintedGrant>()

  constructor(options: CollabClientOptions) {
    this.baseUrl = normalizeServiceUrl(options.baseUrl)
    this.accessToken = options.accessToken
    this.fetchImpl = options.fetchImpl
    this.now = options.now ?? (() => Date.now())
  }

  /** Drop a cached grant, e.g. after signing out. */
  forgetGrant(orgId?: string): void {
    if (orgId === undefined) this.grants.clear()
    else this.grants.delete(orgId)
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

  async listEvents(orgId: string, issueId: string): Promise<CollabIssueEvent[]> {
    return this.json<CollabIssueEvent[]>(
      orgId,
      `/v1/orgs/${encodeURIComponent(orgId)}/issues/${encodeURIComponent(issueId)}/events`
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

  private async json<T>(orgId: string, path: string): Promise<T> {
    const attempt = async (grant: string) =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${grant}` },
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

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new CollabError(response.status, await readError(response))
  }
  return (await response.json()) as T
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === "string" && body.error) return body.error
  } catch {
    // A non-JSON body (a proxy's HTML error page) is not worth a second failure.
  }
  return `collaboration plane returned ${response.status}`
}

/**
 * The unified cloud sign-in, end to end, with no UI in it.
 *
 * # The shape of a sign-in
 *
 * 1. Discovery says which Logto to talk to and which methods it offers
 *    (`lib/identity/deployment-discovery.ts`).
 * 2. The person authenticates: a social button (`direct_sign_in`), the plain
 *    Logto page, or a manual configuration under Advanced. The token that
 *    comes back names a subject and no organization yet.
 * 3. `GET /v1/account/memberships` on the collaboration server answers with
 *    every organization the subject holds standing in. None means the person
 *    either claims the deployment (bootstrap credential) or redeems an
 *    invitation. One is adopted. Several are offered.
 * 4. Adopting an organization mints an organization token (a refresh with
 *    `organization_id`), binds the profile to the SERVER's ids, points the
 *    collaboration connection at the service, and pulls the plane.
 *
 * # Why the server's ids win
 *
 * The first sign-in derives a user id and an org id from the Logto claims so
 * every machine agrees without asking anyone. The server, once reached,
 * assigns its own and keys every route on them. Step 4 therefore rebinds to
 * the ids the server answered with, rekeying whatever the derived ids had
 * already been written on (`reconcileUserId`), and keeps the derived user id
 * as a legacy alias.
 */

import { completeSignIn, type CompleteSignInDeps } from "./complete-sign-in"
import { clearPendingInvitation, readPendingInvitation } from "./pending-invitation"
import { reconcileUserId } from "./reconcile-user-id"
import { UserBindingRegistry } from "./user-binding"

import { CollabClient, type CollabAccountMembership } from "@/lib/collab/client"
import { saveCollabConnection } from "@/lib/collab/connection"
import { refreshCollabPlaneQuietly } from "@/lib/collab/refresh"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  refreshLogtoToken,
  type LogtoClientConfig,
  type LogtoDrivers,
  type LogtoSession,
} from "@/lib/logto/client"
import { saveLogtoSession } from "@/lib/logto/session-store"
import { signInToLogto } from "@/lib/logto/app-session"
import { createPlatformFetch } from "@/lib/network/platform-fetch"

import type { ReadyDeployment } from "./deployment-discovery"

/** Logto only mints organization tokens for a session that asked for this. */
export const ORGANIZATIONS_SCOPE = "urn:logto:scope:organizations"

export type CloudSignInMethod =
  | { kind: "social"; directSignIn: string }
  | { kind: "logto" }
  | { kind: "manual"; config: LogtoClientConfig }

export type CloudSignInErrorCode =
  | "no-collaboration-service"
  | "reauth-required"
  | "not-invited"
  | "invalid-invitation"
  | "cancelled"

export class CloudSignInError extends Error {
  constructor(
    readonly code: CloudSignInErrorCode,
    message: string
  ) {
    super(message)
    this.name = "CloudSignInError"
  }
}

export interface CloudSignInDeps {
  localAccountId?: string
  signIn?: typeof signInToLogto
  complete?: (session: LogtoSession, deps: CompleteSignInDeps) => Promise<unknown>
  refresh?: typeof refreshLogtoToken
  save?: typeof saveLogtoSession
  fetchImpl?: typeof fetch
  registry?: Pick<UserBindingRegistry, "get" | "setOrgId" | "reconcileUserId">
  makeClient?: (
    baseUrl: string,
    accessToken: string
  ) => Pick<CollabClient, "accountMemberships" | "bootstrapAccount" | "acceptInvitationByToken">
  saveConnection?: typeof saveCollabConnection
  reconcile?: typeof reconcileUserId
  refreshPlane?: (localAccountId: string) => Promise<unknown>
  operationId?: () => string
  now?: () => number
}

function fetchFor(deps: CloudSignInDeps): typeof fetch {
  return deps.fetchImpl ?? (createPlatformFetch() as unknown as typeof fetch)
}

function clientFor(deps: CloudSignInDeps, baseUrl: string, accessToken: string) {
  if (deps.makeClient) return deps.makeClient(baseUrl, accessToken)
  return new CollabClient({
    baseUrl,
    accessToken: async () => accessToken,
    fetchImpl: fetchFor(deps),
  })
}

function newOperationId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `op_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export interface LogtoConfigOptions {
  redirectUri: string
  /** Web popups use the web application, desktop and CLI the native one. */
  clientKind: "web" | "native"
  directSignIn?: string
  organizationId?: string
}

/** The client configuration discovery implies, for one method. */
export function logtoConfigFor(
  deployment: ReadyDeployment,
  options: LogtoConfigOptions
): LogtoClientConfig {
  const oidc = deployment.config.oidc
  if (!oidc) throw new Error("the deployment announces no OIDC configuration")
  const clientId =
    options.clientKind === "native" && oidc.nativeClientId ? oidc.nativeClientId : oidc.webClientId
  const scopes = Array.from(new Set([...(oidc.scopes ?? []), ORGANIZATIONS_SCOPE]))
  return {
    issuer: oidc.issuer,
    clientId,
    redirectUri: options.redirectUri,
    resource: oidc.audience,
    scopes,
    ...(options.directSignIn ? { directSignIn: options.directSignIn } : {}),
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
  }
}

/**
 * Authenticate and bind the profile to the person. No organization yet: the
 * binding carries the derived user id until an organization is adopted.
 */
export async function signInWithDeployment(
  deployment: ReadyDeployment,
  method: CloudSignInMethod,
  drivers: LogtoDrivers,
  options: Omit<LogtoConfigOptions, "directSignIn" | "organizationId">,
  deps: CloudSignInDeps = {}
): Promise<LogtoSession> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  const config =
    method.kind === "manual"
      ? method.config
      : logtoConfigFor(deployment, {
          ...options,
          ...(method.kind === "social" ? { directSignIn: method.directSignIn } : {}),
        })
  const session = await (deps.signIn ?? signInToLogto)(config, drivers, { localAccountId })
  await (deps.complete ?? completeSignIn)(session, { localAccountId })
  return session
}

export type AccountStanding =
  | { kind: "none" }
  | { kind: "one"; membership: CollabAccountMembership }
  | { kind: "many"; memberships: CollabAccountMembership[] }

/** What the collaboration server says this subject holds. */
export async function resolveStanding(
  deployment: ReadyDeployment,
  session: LogtoSession,
  deps: CloudSignInDeps = {}
): Promise<AccountStanding> {
  if (!deployment.collaborationServiceUrl) {
    throw new CloudSignInError(
      "no-collaboration-service",
      "the deployment announces no collaboration service, so there is nothing to join"
    )
  }
  const client = clientFor(deps, deployment.collaborationServiceUrl, session.accessToken)
  const { memberships } = await client.accountMemberships()
  if (memberships.length === 0) return { kind: "none" }
  if (memberships.length === 1) return { kind: "one", membership: memberships[0]! }
  return { kind: "many", memberships }
}

export interface OrganizationTarget {
  /** The server's org id, the one every route is keyed on. */
  orgId: string
  logtoOrganizationId: string
  /** The server's user id for this person in that org. */
  userId: string
}

export interface AdoptedOrganization {
  session: LogtoSession
  orgId: string
  userId: string
  /** True when the binding carried a derived id that was moved aside. */
  reconciled: boolean
}

/**
 * Make one organization the profile's: an organization token, the binding on
 * the server's ids, the collaboration connection, and a first pull.
 */
export async function adoptOrganization(
  deployment: ReadyDeployment,
  session: LogtoSession,
  target: OrganizationTarget,
  deps: CloudSignInDeps = {}
): Promise<AdoptedOrganization> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  if (!deployment.collaborationServiceUrl) {
    throw new CloudSignInError(
      "no-collaboration-service",
      "the deployment announces no collaboration service"
    )
  }
  if (!session.refreshToken) {
    throw new CloudSignInError(
      "reauth-required",
      "the session has no refresh token, so an organization token cannot be minted"
    )
  }
  const now = deps.now ?? Date.now
  // An organization token: the same session, narrowed. Logto answers the
  // refresh grant with `organization_id` only when the authorize request
  // carried the organizations scope, which `logtoConfigFor` always adds.
  const orgSession = await (deps.refresh ?? refreshLogtoToken)(
    {
      issuer: session.issuer,
      clientId: session.clientId,
      resource: session.resource,
      redirectUri: "",
      organizationId: target.logtoOrganizationId,
      scopes: session.scopes,
    },
    session.refreshToken,
    fetchFor(deps)
  )
  const merged: LogtoSession = {
    ...orgSession,
    organizationId: target.logtoOrganizationId,
    refreshToken: orgSession.refreshToken ?? session.refreshToken,
    idToken: orgSession.idToken ?? session.idToken,
  }
  await (deps.save ?? saveLogtoSession)(merged, localAccountId)

  // Bind with the organization claim, then move the binding to the server's
  // ids. The derived user id becomes a legacy alias, and every projection row
  // written under it is rekeyed.
  await (deps.complete ?? completeSignIn)(merged, { localAccountId })
  const registry = deps.registry ?? new UserBindingRegistry()
  const binding = await registry.get(localAccountId)
  let reconciled = false
  if (binding && binding.userId !== target.userId) {
    await (deps.reconcile ?? reconcileUserId)(
      {
        localAccountId,
        legacyUserId: binding.userId,
        canonicalUserId: target.userId,
        accessToken: merged.accessToken,
        orgId: target.orgId,
        now: now(),
      },
      { registry }
    )
    reconciled = true
  }
  await registry.setOrgId(localAccountId, target.orgId, now())

  ;(deps.saveConnection ?? saveCollabConnection)(localAccountId, {
    baseUrl: deployment.collaborationServiceUrl,
  })
  await (deps.refreshPlane ?? ((id: string) => refreshCollabPlaneQuietly({ localAccountId: id })))(
    localAccountId
  )
  return { session: merged, orgId: target.orgId, userId: target.userId, reconciled }
}

export interface ClaimDeploymentInput {
  credential: string
  orgName: string
  displayName?: string
  email?: string
}

/** First owner: present the one-time credential, then adopt the new org. */
export async function claimDeployment(
  deployment: ReadyDeployment,
  session: LogtoSession,
  input: ClaimDeploymentInput,
  deps: CloudSignInDeps = {}
): Promise<AdoptedOrganization> {
  if (!deployment.collaborationServiceUrl) {
    throw new CloudSignInError(
      "no-collaboration-service",
      "the deployment announces no collaboration service"
    )
  }
  const client = clientFor(deps, deployment.collaborationServiceUrl, session.accessToken)
  const created = await client.bootstrapAccount({
    operationId: (deps.operationId ?? newOperationId)(),
    credential: input.credential.trim(),
    orgName: input.orgName.trim(),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.email ? { email: input.email } : {}),
  })
  return adoptOrganization(
    deployment,
    session,
    {
      orgId: created.orgId,
      logtoOrganizationId: created.logtoOrganizationId,
      userId: created.userId,
    },
    deps
  )
}

/** Redeem an invitation token, then adopt the org it named. */
export async function redeemInvitation(
  deployment: ReadyDeployment,
  session: LogtoSession,
  token: string,
  deps: CloudSignInDeps & { displayName?: string } = {}
): Promise<AdoptedOrganization> {
  if (!deployment.collaborationServiceUrl) {
    throw new CloudSignInError(
      "no-collaboration-service",
      "the deployment announces no collaboration service"
    )
  }
  const client = clientFor(deps, deployment.collaborationServiceUrl, session.accessToken)
  const accepted = await client.acceptInvitationByToken({
    operationId: (deps.operationId ?? newOperationId)(),
    token: token.trim(),
    ...(deps.displayName ? { displayName: deps.displayName } : {}),
  })
  clearPendingInvitation()
  return adoptOrganization(
    deployment,
    session,
    {
      orgId: accepted.orgId,
      logtoOrganizationId: accepted.logtoOrganizationId,
      userId: accepted.userId,
    },
    deps
  )
}

/**
 * Standing plus the invitation that arrived before sign-in, as one decision:
 * a pending token is redeemed before the memberships are even looked at,
 * because that is what the person came here to do.
 */
export async function settleAfterSignIn(
  deployment: ReadyDeployment,
  session: LogtoSession,
  deps: CloudSignInDeps = {}
): Promise<
  | { outcome: "adopted"; adopted: AdoptedOrganization }
  | { outcome: "choose"; memberships: CollabAccountMembership[] }
  | { outcome: "unaffiliated" }
> {
  const pending = readPendingInvitation()
  if (pending) {
    return {
      outcome: "adopted",
      adopted: await redeemInvitation(deployment, session, pending, deps),
    }
  }
  const standing = await resolveStanding(deployment, session, deps)
  switch (standing.kind) {
    case "none":
      return { outcome: "unaffiliated" }
    case "one":
      return {
        outcome: "adopted",
        adopted: await adoptOrganization(
          deployment,
          session,
          {
            orgId: standing.membership.orgId,
            logtoOrganizationId: standing.membership.logtoOrganizationId ?? "",
            userId: standing.membership.userId,
          },
          deps
        ),
      }
    case "many":
      return { outcome: "choose", memberships: standing.memberships }
  }
}

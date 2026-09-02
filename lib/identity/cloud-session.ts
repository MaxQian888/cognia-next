/**
 * The cloud identity of one LocalProfile, as one value the UI can switch on.
 *
 * # Why a union and not a nullable session
 *
 * "Is there a session" was the only question the old shape could answer, and
 * it answered it wrongly: an expired token came back as a session, so the
 * Account surface, the pairing flow and the collaboration refresh all treated
 * a dead login as a live one until something downstream returned 401. The
 * states below are the states a person is actually in, and each carries only
 * what that state can honestly show.
 *
 * - `signed-out`: nobody has signed into this profile.
 * - `active`: a usable token AND a profile binding. The only state in which
 *   anything may act as this person.
 * - `reauth-required`: the login is over, and the reason says why. `expired`
 *   and `revoked` come from the issuer. `binding-missing` is local: the token
 *   is fine but the profile was never bound to the person it names (a crash
 *   between the two writes, or a registry wipe), so acting on it would be
 *   acting as an unbound identity.
 * - `offline`: the issuer could not be reached. The person is still who they
 *   were, the tokens are kept for a later refresh, and nothing that needs the
 *   cloud should run. Local data stays fully usable.
 * - `error`: the issuer answered, but not usefully. Named so an operator can
 *   read the reason instead of a generic failure.
 *
 * The person-level summary comes from the token's claims plus the binding, and
 * proves nothing: `lib/identity/logto-claims.ts` is unverified extraction, and
 * the collaboration server re-decides everything on its own tables.
 */

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  resolveLogtoSession,
  type LogtoAppSessionDeps,
  type LogtoSessionResolution,
} from "@/lib/logto/app-session"
import type { LogtoSession, LogtoSessionMetadata } from "@/lib/logto/client"

import { readLogtoIdentity } from "./logto-claims"
import { UserBindingRegistry } from "./user-binding"

import type { UserBindingRow } from "@/lib/accounts/account-db"
import type { OrgRole } from "@/types/identity"

/** Who this profile is signed in as, for display. Not an authorization input. */
export interface AccountIdentitySummary {
  /** The canonical `usr_…` the profile is bound to. */
  userId: string
  /** The Logto subject the token names. An identifier, never a key. */
  logtoSubject: string
  displayName?: string
  email?: string
  /** The `org_…` the binding names, when the session is organization-scoped. */
  orgId?: string
  /** The Logto organization the token is scoped to, when it is. */
  logtoOrganizationId?: string
  /** The role the token's `organization_roles` map to. A hint until the server says. */
  orgRole?: OrgRole
}

export type CloudSessionReauthReason = "expired" | "revoked" | "binding-missing"

export type CloudSessionState =
  | { status: "signed-out" }
  | { status: "active"; session: LogtoSession; identity: AccountIdentitySummary }
  | {
      status: "reauth-required"
      reason: CloudSessionReauthReason
      /** What is known about the lapsed login, so the prompt can name it. */
      sessionMetadata: LogtoSessionMetadata | null
    }
  | { status: "offline"; sessionMetadata: LogtoSessionMetadata }
  | { status: "error"; reason: string; sessionMetadata: LogtoSessionMetadata | null }

export interface ReadCloudSessionStateDeps {
  /** Defaults to the profile this runtime is serving. */
  localAccountId?: string
  registry?: Pick<UserBindingRegistry, "get">
  /** The token-level resolution. Injectable so a test needs no keyring. */
  resolve?: (deps: LogtoAppSessionDeps) => Promise<LogtoSessionResolution>
  session?: Omit<LogtoAppSessionDeps, "localAccountId">
}

/** Build the display summary from what the token and the binding say. */
export function summarizeIdentity(
  session: LogtoSession,
  binding: UserBindingRow
): AccountIdentitySummary {
  const identity = readLogtoIdentity(session)
  const summary: AccountIdentitySummary = {
    userId: binding.userId,
    logtoSubject: binding.logtoSubject,
  }
  const displayName = binding.displayName ?? identity?.profile.name
  const email = binding.email ?? identity?.profile.email
  if (displayName) summary.displayName = displayName
  if (email) summary.email = email
  if (binding.orgId) summary.orgId = binding.orgId
  if (identity?.access.organizationId) {
    summary.logtoOrganizationId = identity.access.organizationId
    summary.orgRole = identity.orgRole
  }
  return summary
}

/**
 * Where this profile stands with the cloud, right now.
 *
 * Never throws on the issuer's account. A registry that cannot be read is a
 * local fault and does propagate, because "signed out" would be a lie about
 * a profile that may well be bound.
 */
export async function readCloudSessionState(
  deps: ReadCloudSessionStateDeps = {}
): Promise<CloudSessionState> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  const resolve = deps.resolve ?? resolveLogtoSession
  const resolved = await resolve({ ...deps.session, localAccountId })

  switch (resolved.status) {
    case "none":
      return { status: "signed-out" }
    case "reauth-required":
      return {
        status: "reauth-required",
        reason: resolved.reason,
        sessionMetadata: resolved.metadata,
      }
    case "offline":
      return { status: "offline", sessionMetadata: resolved.metadata }
    case "error":
      return { status: "error", reason: resolved.reason, sessionMetadata: resolved.metadata }
    case "active": {
      const registry = deps.registry ?? new UserBindingRegistry()
      const binding = await registry.get(localAccountId)
      if (!binding) {
        return {
          status: "reauth-required",
          reason: "binding-missing",
          sessionMetadata: {
            issuer: resolved.session.issuer,
            clientId: resolved.session.clientId,
            resource: resolved.session.resource,
            scopes: [...resolved.session.scopes],
            ...(resolved.session.organizationId
              ? { organizationId: resolved.session.organizationId }
              : {}),
            ...(resolved.session.expiresAt !== undefined
              ? { expiresAt: resolved.session.expiresAt }
              : {}),
          },
        }
      }
      return {
        status: "active",
        session: resolved.session,
        identity: summarizeIdentity(resolved.session, binding),
      }
    }
  }
}

/** True for the states in which anything cloud-side may run as this person. */
export function isCloudSessionActive(
  state: CloudSessionState
): state is Extract<CloudSessionState, { status: "active" }> {
  return state.status === "active"
}

/**
 * True when the person should be asked to sign in again. `offline` is not
 * that: asking somebody to re-authenticate because the network dropped would
 * throw away a refresh token that still works.
 */
export function cloudSessionNeedsReauth(
  state: CloudSessionState
): state is Extract<CloudSessionState, { status: "reauth-required" }> {
  return state.status === "reauth-required"
}

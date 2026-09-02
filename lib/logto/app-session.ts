/**
 * Desktop/web app-session layer for Logto (ADR-0059 cloud/headless, Logto).
 *
 * Assembles the runtime-agnostic client ({@link ./client}) with the OS-keyring
 * store ({@link ./session-store}) into the actions the app drives: interactive
 * sign-in, resolve-the-active-session (with lazy refresh), and sign-out. This
 * is the app (Tauri/web keyring) counterpart to the standalone CLI's
 * file-backed session (`cli/src/config/logto-session.ts`). Same client,
 * different persistence, because the `cognia-agent` process has no OS keyring.
 *
 * # An expired token is never "active"
 *
 * `getActiveLogtoSession` used to surface a stale session when the refresh
 * failed, so a caller could not tell "refresh the token later" from "this
 * login is dead". Worse, both looked exactly like a healthy session. The
 * resolution is now a discriminated union ({@link LogtoSessionResolution}):
 * `active` is the only state that carries a token, a refused refresh becomes a
 * `reauth-required` marker with the tokens cleared, and an unreachable issuer
 * is `offline` with the material kept for the next attempt.
 *
 * Every effect is injectable so the orchestration unit-tests without a real
 * browser round-trip, network, or keyring.
 */

import { createPlatformFetch } from "@/lib/network/platform-fetch"

import { discoverLogtoEndpoints } from "./discovery"
import {
  buildLogtoEndSessionUrl,
  isLogtoRefreshError,
  loginToLogto,
  refreshLogtoToken,
  revokeLogtoToken,
  toLogtoSessionMetadata,
  type LogtoClientConfig,
  type LogtoDrivers,
  type LogtoRevocationOutcome,
  type LogtoSession,
  type LogtoSessionMetadata,
} from "./client"
import {
  clearLogtoReauthMarker,
  clearLogtoSession,
  loadLogtoReauthMarker,
  loadLogtoSession,
  markLogtoSessionForReauth,
  saveLogtoSession,
  type LogtoReauthMarker,
} from "./session-store"

/** Refresh this far ahead of the actual expiry so a request never races it. */
export const REFRESH_SKEW_MS = 60_000

export interface LogtoAppSessionDeps {
  /** Defaults to the profile this runtime is serving. */
  localAccountId?: string
  login?: typeof loginToLogto
  refresh?: typeof refreshLogtoToken
  revoke?: typeof revokeLogtoToken
  discover?: typeof discoverLogtoEndpoints
  load?: typeof loadLogtoSession
  save?: typeof saveLogtoSession
  clear?: typeof clearLogtoSession
  loadReauth?: typeof loadLogtoReauthMarker
  markReauth?: typeof markLogtoSessionForReauth
  clearReauth?: typeof clearLogtoReauthMarker
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * What the keyring holds for one profile, after any refresh it needed.
 *
 * - `none`: nothing stored. Nobody has signed in here.
 * - `active`: a token that is good right now. The only state with one.
 * - `reauth-required`: the refresh was refused. Tokens are gone, metadata stays.
 * - `offline`: the issuer could not be reached. Tokens are KEPT so the next
 *   attempt can refresh. The caller gets no token because presenting an
 *   expired one is pointless.
 * - `error`: the issuer answered but not usefully (a misconfigured client, a
 *   malformed response). Material kept, state surfaced, nothing pretends to
 *   be signed in.
 */
export type LogtoSessionResolution =
  | { status: "none" }
  | { status: "active"; session: LogtoSession }
  | { status: "reauth-required"; reason: "expired" | "revoked"; metadata: LogtoSessionMetadata }
  | { status: "offline"; metadata: LogtoSessionMetadata }
  | { status: "error"; reason: string; metadata: LogtoSessionMetadata }

/** Interactive sign-in: run the PKCE flow, then persist the session to the keyring. */
export async function signInToLogto(
  config: LogtoClientConfig,
  drivers: LogtoDrivers,
  deps: LogtoAppSessionDeps = {}
): Promise<LogtoSession> {
  const login = deps.login ?? loginToLogto
  const save = deps.save ?? saveLogtoSession
  const session = await login(config, drivers)
  await save(session, deps.localAccountId)
  return session
}

function refreshConfigFor(session: LogtoSession): LogtoClientConfig {
  return {
    issuer: session.issuer,
    clientId: session.clientId,
    resource: session.resource,
    // redirectUri is unused by the refresh grant, but the config type requires it.
    redirectUri: "",
    ...(session.organizationId ? { organizationId: session.organizationId } : {}),
  }
}

/**
 * The platform transport rather than bare `fetch`: the desktop routes it
 * through the configured proxy, and the issuer would otherwise be the one
 * host every other call honours the proxy for and this one does not.
 */
function issuerFetch(deps: LogtoAppSessionDeps): typeof fetch {
  return deps.fetchImpl ?? (createPlatformFetch() as unknown as typeof fetch)
}

function isStale(session: LogtoSession, now: number): boolean {
  return session.expiresAt != null && session.expiresAt - now <= REFRESH_SKEW_MS
}

/**
 * Resolve this profile's session, refreshing when the access token has expired
 * (or is within {@link REFRESH_SKEW_MS} of expiring) and a refresh token exists.
 *
 * A refused refresh (`invalid_grant`) clears the tokens and leaves a marker.
 * A transient failure keeps everything and reports `offline`. Either way the
 * caller never receives a token that has stopped working.
 */
export async function resolveLogtoSession(
  deps: LogtoAppSessionDeps = {}
): Promise<LogtoSessionResolution> {
  const load = deps.load ?? loadLogtoSession
  const loadReauth = deps.loadReauth ?? loadLogtoReauthMarker
  const refresh = deps.refresh ?? refreshLogtoToken
  const save = deps.save ?? saveLogtoSession
  const markReauth = deps.markReauth ?? markLogtoSessionForReauth
  const now = deps.now ?? Date.now

  const session = await load(deps.localAccountId)
  if (!session) {
    const marker = await loadReauth(deps.localAccountId)
    if (marker) {
      return { status: "reauth-required", reason: marker.reason, metadata: marker.metadata }
    }
    return { status: "none" }
  }

  if (!isStale(session, now())) return { status: "active", session }

  const metadata = toLogtoSessionMetadata(session)
  if (!session.refreshToken) {
    // Nothing to refresh with. The token is past its expiry and the only way
    // forward is a new interactive sign-in, so say so and drop the token. It
    // is not a credential any more, only a liability.
    const marker: LogtoReauthMarker = { reason: "expired", metadata, at: now() }
    await markReauth(marker, deps.localAccountId)
    return { status: "reauth-required", reason: "expired", metadata }
  }

  try {
    const refreshed = await refresh(
      refreshConfigFor(session),
      session.refreshToken,
      issuerFetch(deps)
    )
    await save(refreshed, deps.localAccountId)
    return { status: "active", session: refreshed }
  } catch (error) {
    if (isLogtoRefreshError(error)) {
      if (error.permanent) {
        const marker: LogtoReauthMarker = { reason: error.reauthReason, metadata, at: now() }
        await markReauth(marker, deps.localAccountId)
        return { status: "reauth-required", reason: marker.reason, metadata }
      }
      if (error.transient) return { status: "offline", metadata }
      return { status: "error", reason: error.message, metadata }
    }
    // An injected `refresh` that throws something untyped is still not a
    // reason to invent a revocation: keep the material, surface the failure.
    return {
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
      metadata,
    }
  }
}

/**
 * The active session, or `null` for every state that has no usable token.
 *
 * Kept for callers that only need a token. The states behind `null` are
 * distinguished by {@link resolveLogtoSession}, and a UI should call that
 * instead so it can name them.
 */
export async function getActiveLogtoSession(
  deps: LogtoAppSessionDeps = {}
): Promise<LogtoSession | null> {
  const resolved = await resolveLogtoSession(deps)
  return resolved.status === "active" ? resolved.session : null
}

/**
 * A token that is good right now, or `null`.
 *
 * The one call the collaboration plane, its outbound queue and its runtime
 * client should make. Reading the keyring directly hands them whatever is
 * stored, expired or not, and a request made with an expired token is a 401
 * that looks exactly like a revoked login.
 */
export async function readActiveAccessToken(
  localAccountId?: string,
  deps: Omit<LogtoAppSessionDeps, "localAccountId"> = {}
): Promise<string | null> {
  const session = await getActiveLogtoSession({ ...deps, localAccountId })
  return session?.accessToken ?? null
}

export interface LogtoSignOutOptions {
  /**
   * Revoke the refresh (and access) token at the issuer before clearing them.
   * On by default: a sign-out that only forgets a token locally leaves it live
   * at the issuer for the rest of its lifetime.
   */
  revoke?: boolean
  /** Where the issuer may send the browser after ending its own session. */
  postLogoutRedirectUri?: string
}

export interface LogtoSignOutReport {
  /** Whether there was a session to sign out of. */
  hadSession: boolean
  /** Local material is always cleared, whatever the issuer said. */
  cleared: true
  refreshTokenRevocation: LogtoRevocationOutcome | null
  accessTokenRevocation: LogtoRevocationOutcome | null
  /**
   * The issuer's RP-initiated logout URL, when it advertises one. Opening it
   * ends the issuer's browser cookie, which revocation does not.
   */
  endSessionUrl: string | null
}

/** True when the issuer may still consider a token live after this sign-out. */
export function signOutLeftTokensLive(report: LogtoSignOutReport): boolean {
  if (!report.hadSession) return false
  return [report.refreshTokenRevocation, report.accessTokenRevocation].some(
    (outcome) => outcome?.status === "failed"
  )
}

/**
 * Sign out: revoke at the issuer (best effort, reported), then drop the
 * session and any re-authentication marker from the keyring.
 *
 * Idempotent, and it never throws on the issuer's account: the local clear is
 * the part that must happen, and it happens last so a crash mid-way leaves a
 * token that is revoked rather than one that is forgotten but live.
 */
export async function signOutFromLogto(
  deps: LogtoAppSessionDeps = {},
  options: LogtoSignOutOptions = {}
): Promise<LogtoSignOutReport> {
  const load = deps.load ?? loadLogtoSession
  const clear = deps.clear ?? clearLogtoSession
  const clearReauth = deps.clearReauth ?? clearLogtoReauthMarker
  const revoke = deps.revoke ?? revokeLogtoToken
  const discover = deps.discover ?? discoverLogtoEndpoints
  const shouldRevoke = options.revoke ?? true

  const session = await load(deps.localAccountId)
  let refreshTokenRevocation: LogtoRevocationOutcome | null = null
  let accessTokenRevocation: LogtoRevocationOutcome | null = null
  let endSessionUrl: string | null = null

  if (session) {
    const fetchImpl = issuerFetch(deps)
    if (shouldRevoke) {
      if (session.refreshToken) {
        refreshTokenRevocation = await revoke(
          session,
          session.refreshToken,
          "refresh_token",
          fetchImpl
        )
      }
      accessTokenRevocation = await revoke(session, session.accessToken, "access_token", fetchImpl)
    }
    try {
      const endpoints = await discover(session.issuer, fetchImpl)
      endSessionUrl = buildLogtoEndSessionUrl(endpoints, {
        clientId: session.clientId,
        ...(session.idToken ? { idToken: session.idToken } : {}),
        ...(options.postLogoutRedirectUri
          ? { postLogoutRedirectUri: options.postLogoutRedirectUri }
          : {}),
      })
    } catch {
      // No discovery, no logout URL. The revocation above already said
      // whether the issuer could be reached, so this is not a second failure.
      endSessionUrl = null
    }
  }

  await clear(deps.localAccountId)
  await clearReauth(deps.localAccountId)

  return {
    hadSession: Boolean(session),
    cleared: true,
    refreshTokenRevocation,
    accessTokenRevocation,
    endSessionUrl,
  }
}

/**
 * Desktop/web app-session layer for Logto (ADR-0059 cloud/headless — Logto).
 *
 * Assembles the runtime-agnostic client ({@link ./client}) with the OS-keyring
 * store ({@link ./session-store}) into the three actions the settings UI drives:
 * interactive sign-in, read-the-active-session (with lazy refresh), and
 * sign-out. This is the app (Tauri/web keyring) counterpart to the standalone
 * CLI's file-backed session (`cli/src/config/logto-session.ts`) — same client,
 * different persistence, because the `cognia-agent` process has no OS keyring.
 *
 * Every effect is injectable so the orchestration unit-tests without a real
 * browser round-trip, network, or keyring.
 */

import {
  loginToLogto,
  refreshLogtoToken,
  type LogtoClientConfig,
  type LogtoDrivers,
  type LogtoSession,
} from "./client"
import { clearLogtoSession, loadLogtoSession, saveLogtoSession } from "./session-store"

/** Refresh this far ahead of the actual expiry so a request never races it. */
export const REFRESH_SKEW_MS = 60_000

export interface LogtoAppSessionDeps {
  login?: typeof loginToLogto
  refresh?: typeof refreshLogtoToken
  load?: typeof loadLogtoSession
  save?: typeof saveLogtoSession
  clear?: typeof clearLogtoSession
  now?: () => number
}

/** Interactive sign-in: run the PKCE flow, then persist the session to the keyring. */
export async function signInToLogto(
  config: LogtoClientConfig,
  drivers: LogtoDrivers,
  deps: LogtoAppSessionDeps = {}
): Promise<LogtoSession> {
  const login = deps.login ?? loginToLogto
  const save = deps.save ?? saveLogtoSession
  const session = await login(config, drivers)
  await save(session)
  return session
}

/**
 * Load the active session. When the access token has expired (or is within
 * {@link REFRESH_SKEW_MS} of expiring) and a refresh token is present, refresh
 * and re-persist. Returns `null` when nothing is stored. A failed refresh
 * surfaces the stale session (so the UI can prompt re-auth) rather than
 * silently signing the user out.
 */
export async function getActiveLogtoSession(
  deps: LogtoAppSessionDeps = {}
): Promise<LogtoSession | null> {
  const load = deps.load ?? loadLogtoSession
  const refresh = deps.refresh ?? refreshLogtoToken
  const save = deps.save ?? saveLogtoSession
  const now = deps.now ?? Date.now

  const session = await load()
  if (!session) return null

  const stale = session.expiresAt != null && session.expiresAt - now() <= REFRESH_SKEW_MS
  if (!stale || !session.refreshToken) return session

  try {
    const config: LogtoClientConfig = {
      issuer: session.issuer,
      clientId: session.clientId,
      resource: session.resource,
      // redirectUri is unused by the refresh grant, but the config type requires it.
      redirectUri: "",
      ...(session.organizationId ? { organizationId: session.organizationId } : {}),
    }
    const refreshed = await refresh(config, session.refreshToken)
    await save(refreshed)
    return refreshed
  } catch {
    return session
  }
}

/** Sign out: drop the active session from the keyring. Idempotent. */
export async function signOutFromLogto(deps: LogtoAppSessionDeps = {}): Promise<void> {
  const clear = deps.clear ?? clearLogtoSession
  await clear()
}

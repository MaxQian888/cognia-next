/**
 * Google OAuth 2.0 for the Drive backup destination — DEVICE FLOW
 * ("OAuth 2.0 for TV and Limited-Input Devices"), spec 2026-08-16 D / Q30.
 *
 * Why device flow: it needs no redirect listener, no loopback port and no
 * Rust/Node helper, so the SAME TypeScript runs on the desktop and on the
 * headless brain, and a companion page only has to display the user code.
 * The `drive.file` scope (per-file access to what this app created) is one
 * of the scopes Google permits for the device flow.
 *
 *   1. `beginGoogleDeviceAuth`  → POST oauth2.googleapis.com/device/code
 *      returns { deviceCode, userCode, verificationUrl, interval, expiresAt }
 *   2. user opens verificationUrl and types userCode
 *   3. `pollGoogleDeviceAuth`   → POST oauth2.googleapis.com/token with
 *      grant_type=device_code until Google returns tokens (or expires/denies)
 *   4. tokens are stored in the host keyring; `getGoogleDriveAccessToken`
 *      refreshes silently with the refresh token when the access token is
 *      about to expire.
 *
 * The user supplies their own OAuth client (Google Cloud → "Desktop app"
 * credential): client id in settings, client secret in the keyring.
 */

import {
  getBackupDestinationsSettings,
  getGoogleDriveClientSecret,
  loadGoogleDriveTokens,
  resolveGoogleDriveBackupConfig,
  saveGoogleDriveTokens,
  updateBackupDestinationsSettings,
  type GoogleOAuthTokens,
} from "./config"
import { backupHttpRequest, parseJsonBody, type BackupHttpFn } from "./http"

export const GOOGLE_DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code"
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
/** Refresh when fewer than this many ms of validity remain. */
export const REFRESH_SKEW_MS = 60_000

export interface GoogleDeviceAuthChallenge {
  deviceCode: string
  userCode: string
  verificationUrl: string
  /** Seconds between polls (Google says ≥ 5). */
  intervalSeconds: number
  /** Epoch ms after which the challenge is dead. */
  expiresAt: number
}

export type GoogleDeviceAuthPoll =
  | { status: "pending" }
  | { status: "slow_down"; intervalSeconds: number }
  | { status: "authorized"; tokens: GoogleOAuthTokens }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; error: string }

export interface GoogleOAuthDeps {
  http?: BackupHttpFn
  now?: () => number
}

function form(body: Record<string, string>): string {
  return Object.entries(body)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")
}

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" }

/** Step 1 — request a device code for the configured client. */
export async function beginGoogleDeviceAuth(
  deps: GoogleOAuthDeps = {}
): Promise<GoogleDeviceAuthChallenge> {
  const http = deps.http ?? backupHttpRequest
  const now = deps.now ?? Date.now
  const settings = await getBackupDestinationsSettings()
  const config = resolveGoogleDriveBackupConfig(settings.googleDrive, { requireEnabled: false })
  if (!config) throw new Error("Google Drive backup needs an OAuth client id first.")
  const response = await http({
    url: GOOGLE_DEVICE_CODE_URL,
    method: "POST",
    headers: FORM_HEADERS,
    body: form({ client_id: config.clientId, scope: GOOGLE_DRIVE_SCOPE }),
  })
  const parsed = parseJsonBody<{
    device_code?: string
    user_code?: string
    verification_url?: string
    verification_uri?: string
    expires_in?: number
    interval?: number
    error?: string
    error_description?: string
  }>(response.body)
  if (response.status !== 200 || !parsed?.device_code || !parsed.user_code) {
    throw new Error(
      parsed?.error_description ?? parsed?.error ?? `Google returned HTTP ${response.status}`
    )
  }
  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    verificationUrl:
      parsed.verification_url ?? parsed.verification_uri ?? "https://www.google.com/device",
    intervalSeconds: Math.max(5, parsed.interval ?? 5),
    expiresAt: now() + (parsed.expires_in ?? 1800) * 1000,
  }
}

function tokensFromResponse(
  parsed: {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    token_type?: string
  },
  now: number,
  previousRefreshToken?: string
): GoogleOAuthTokens | null {
  if (!parsed.access_token) return null
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? previousRefreshToken,
    expiresAt: now + (parsed.expires_in ?? 3600) * 1000,
    scope: parsed.scope,
    tokenType: parsed.token_type,
  }
}

/** Step 3 — one poll of the token endpoint. Persists tokens on success. */
export async function pollGoogleDeviceAuth(
  challenge: Pick<GoogleDeviceAuthChallenge, "deviceCode" | "expiresAt">,
  deps: GoogleOAuthDeps = {}
): Promise<GoogleDeviceAuthPoll> {
  const http = deps.http ?? backupHttpRequest
  const now = deps.now ?? Date.now
  if (now() >= challenge.expiresAt) return { status: "expired" }
  const settings = await getBackupDestinationsSettings()
  const config = resolveGoogleDriveBackupConfig(settings.googleDrive, { requireEnabled: false })
  if (!config) return { status: "error", error: "Google Drive backup is not configured." }
  const clientSecret = await getGoogleDriveClientSecret()
  if (!clientSecret) return { status: "error", error: "Google OAuth client secret is missing." }
  const response = await http({
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      client_id: config.clientId,
      client_secret: clientSecret,
      device_code: challenge.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  })
  const parsed = parseJsonBody<{
    error?: string
    error_description?: string
    interval?: number
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    token_type?: string
  }>(response.body)
  if (parsed?.error) {
    switch (parsed.error) {
      case "authorization_pending":
        return { status: "pending" }
      case "slow_down":
        return { status: "slow_down", intervalSeconds: parsed.interval ?? 10 }
      case "access_denied":
        return { status: "denied" }
      case "expired_token":
        return { status: "expired" }
      default:
        return { status: "error", error: parsed.error_description ?? parsed.error }
    }
  }
  const tokens = parsed ? tokensFromResponse(parsed, now()) : null
  if (!tokens) return { status: "error", error: `Google returned HTTP ${response.status}` }
  await saveGoogleDriveTokens(tokens)
  const email = await fetchAccountEmail(tokens.accessToken, http).catch(() => undefined)
  await updateBackupDestinationsSettings((current) => ({
    ...current,
    googleDrive: {
      enabled: current.googleDrive?.enabled ?? true,
      ...current.googleDrive,
      connected: Boolean(tokens.refreshToken),
      accountEmail: email ?? current.googleDrive?.accountEmail,
    },
  })).catch(() => undefined)
  return { status: "authorized", tokens }
}

async function fetchAccountEmail(
  accessToken: string,
  http: BackupHttpFn
): Promise<string | undefined> {
  const response = await http({
    url: GOOGLE_USERINFO_URL,
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (response.status !== 200) return undefined
  return parseJsonBody<{ email?: string }>(response.body)?.email
}

/**
 * Drive the whole poll loop to a terminal state. `sleep` is injectable so
 * tests (and a headless brain) do not block on real timers.
 */
export async function completeGoogleDeviceAuth(
  challenge: GoogleDeviceAuthChallenge,
  deps: GoogleOAuthDeps & { sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {}
): Promise<GoogleDeviceAuthPoll> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let interval = challenge.intervalSeconds
  for (;;) {
    if (deps.signal?.aborted) return { status: "denied" }
    const poll = await pollGoogleDeviceAuth(challenge, deps)
    if (poll.status === "pending") {
      await sleep(interval * 1000)
      continue
    }
    if (poll.status === "slow_down") {
      interval = Math.max(interval, poll.intervalSeconds)
      await sleep(interval * 1000)
      continue
    }
    return poll
  }
}

/** Refresh the access token using the stored refresh token. */
export async function refreshGoogleDriveTokens(
  tokens: GoogleOAuthTokens,
  deps: GoogleOAuthDeps = {}
): Promise<GoogleOAuthTokens> {
  const http = deps.http ?? backupHttpRequest
  const now = deps.now ?? Date.now
  if (!tokens.refreshToken)
    throw new Error("No Google refresh token is stored; reconnect Google Drive.")
  const settings = await getBackupDestinationsSettings()
  const config = resolveGoogleDriveBackupConfig(settings.googleDrive, { requireEnabled: false })
  if (!config) throw new Error("Google Drive backup is not configured.")
  const clientSecret = await getGoogleDriveClientSecret()
  if (!clientSecret) throw new Error("Google OAuth client secret is missing.")
  const response = await http({
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      client_id: config.clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }),
  })
  const parsed = parseJsonBody<{
    error?: string
    error_description?: string
    access_token?: string
    expires_in?: number
    scope?: string
    token_type?: string
  }>(response.body)
  const next =
    parsed && !parsed.error ? tokensFromResponse(parsed, now(), tokens.refreshToken) : null
  if (!next) {
    throw new Error(
      parsed?.error_description ??
        parsed?.error ??
        `Google token refresh failed (HTTP ${response.status})`
    )
  }
  await saveGoogleDriveTokens(next)
  return next
}

/** A valid access token, refreshing when needed. `null` when not connected. */
export async function getGoogleDriveAccessToken(
  deps: GoogleOAuthDeps = {}
): Promise<string | null> {
  const now = deps.now ?? Date.now
  const tokens = await loadGoogleDriveTokens()
  if (!tokens) return null
  if (tokens.expiresAt - now() > REFRESH_SKEW_MS) return tokens.accessToken
  if (!tokens.refreshToken) return null
  const refreshed = await refreshGoogleDriveTokens(tokens, deps)
  return refreshed.accessToken
}

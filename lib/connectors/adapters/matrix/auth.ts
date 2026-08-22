/**
 * Matrix authentication helpers.
 *
 * Two ways to obtain a long-lived `access_token`:
 *   1. Paste an existing access token (advanced users / bot accounts created
 *      via the homeserver admin API). The adapter just calls `whoami` to
 *      resolve the bot's `user_id` (selfId).
 *   2. Username + password login (`POST /_matrix/client/v3/login`), which
 *      returns both the `access_token` and the `user_id`.
 *
 * The resolved access token is stored in the Tauri keyring under
 * `<adapterId>:accessToken`; the homeserver base URL is non-secret and lives
 * in `AdapterInstanceRow.settings.homeserver`.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"

const CLIENT_V3 = "/_matrix/client/v3"

/**
 * Normalise a homeserver URL: prepend https:// when no scheme is given and
 * strip any trailing slash so path concatenation stays clean. Returns "" for
 * empty / whitespace input so callers can detect a missing config.
 */
export function normalizeHomeserver(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ""
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, "")
}

export interface MatrixWhoamiResult {
  userId: string
  deviceId?: string
}

export type MatrixAccessTokenProbeResult =
  { ok: true; userId: string; deviceId?: string } | { ok: false; error: string }

/**
 * Resolve the bot's own `user_id` (e.g. `@bot:matrix.org`) plus the
 * homeserver-assigned `device_id` for an access token. Returns null on any
 * non-2xx / parse failure. E2EE startup requires `device_id` and fails
 * closed when it is missing.
 */
export async function matrixWhoamiDetailed(
  homeserver: string,
  accessToken: string
): Promise<MatrixWhoamiResult | null> {
  const base = normalizeHomeserver(homeserver)
  if (!base || !accessToken) return null
  try {
    const resp = await connectorsHttpRequest({
      url: `${base}${CLIENT_V3}/account/whoami`,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (resp.status < 200 || resp.status >= 300) return null
    const parsed = JSON.parse(resp.body) as { user_id?: string; device_id?: string }
    if (!parsed.user_id) return null
    return {
      userId: parsed.user_id,
      ...(parsed.device_id ? { deviceId: parsed.device_id } : {}),
    }
  } catch {
    return null
  }
}

export async function probeMatrixAccessToken(
  homeserver: string,
  accessToken: string
): Promise<MatrixAccessTokenProbeResult> {
  const base = normalizeHomeserver(homeserver)
  if (!base) return { ok: false, error: "Homeserver URL is required" }
  if (!accessToken.trim()) return { ok: false, error: "Access token is required" }

  try {
    const resp = await connectorsHttpRequest({
      url: `${base}${CLIENT_V3}/account/whoami`,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken.trim()}` },
    })

    let parsed: { user_id?: string; device_id?: string; error?: string; errcode?: string }
    try {
      parsed = JSON.parse(resp.body)
    } catch {
      return {
        ok: false,
        error: `Matrix whoami returned non-JSON body (status ${resp.status})`,
      }
    }

    if (resp.status < 200 || resp.status >= 300 || !parsed.user_id) {
      const reason = parsed.error ?? parsed.errcode ?? `status ${resp.status}`
      return { ok: false, error: `Matrix whoami failed: ${reason}` }
    }

    return {
      ok: true,
      userId: parsed.user_id,
      ...(parsed.device_id ? { deviceId: parsed.device_id } : {}),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface MatrixLoginResult {
  accessToken: string
  userId: string
  deviceId?: string
  /**
   * Present when the homeserver issues expiring tokens. Without it a bot dies
   * permanently the first time its access token lapses and the user has to
   * type their password again — see {@link refreshMatrixAccessToken}.
   */
  refreshToken?: string
  /** Lifetime of `accessToken` in ms, when the homeserver states one. */
  expiresInMs?: number
}

/**
 * Password login. Throws on failure with the homeserver's `error` message so
 * the settings form can surface why the login was rejected (wrong password,
 * unknown user, rate-limited, etc.).
 */
export async function matrixLoginWithPassword(
  homeserver: string,
  user: string,
  password: string
): Promise<MatrixLoginResult> {
  const base = normalizeHomeserver(homeserver)
  if (!base) throw new Error("Homeserver URL is required")

  const resp = await connectorsHttpRequest({
    url: `${base}${CLIENT_V3}/login`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user },
      password,
      initial_device_display_name: "Cognia",
      // Without this the homeserver issues a non-refreshable token and the bot
      // dies for good the first time it lapses.
      refresh_token: true,
    }),
  })

  let parsed: {
    access_token?: string
    user_id?: string
    device_id?: string
    refresh_token?: string
    expires_in_ms?: number
    error?: string
    errcode?: string
  }
  try {
    parsed = JSON.parse(resp.body)
  } catch {
    throw new Error(`Matrix login returned non-JSON body (status ${resp.status})`)
  }

  if (resp.status < 200 || resp.status >= 300 || !parsed.access_token || !parsed.user_id) {
    const reason = parsed.error ?? parsed.errcode ?? `status ${resp.status}`
    throw new Error(`Matrix login failed: ${reason}`)
  }

  return {
    accessToken: parsed.access_token,
    userId: parsed.user_id,
    ...(parsed.device_id ? { deviceId: parsed.device_id } : {}),
    ...(parsed.refresh_token ? { refreshToken: parsed.refresh_token } : {}),
    ...(typeof parsed.expires_in_ms === "number" ? { expiresInMs: parsed.expires_in_ms } : {}),
  }
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * Matrix rotates refresh tokens: the response MAY carry a new one, and when it
 * does the old one is dead, so the caller must persist both halves together or
 * the next refresh fails with a token nobody can use.
 *
 * The device — and therefore the E2EE identity and every key it holds — is
 * preserved, which is the whole reason to refresh rather than log in again.
 *
 * @see https://spec.matrix.org/latest/client-server-api/#refreshing-access-tokens
 */
export async function refreshMatrixAccessToken(
  homeserver: string,
  refreshToken: string
): Promise<MatrixRefreshResult> {
  const base = normalizeHomeserver(homeserver)
  if (!base) return { ok: false, reason: "config", error: "Homeserver URL is required" }
  if (!refreshToken.trim()) {
    return { ok: false, reason: "no_refresh_token", error: "No refresh token stored" }
  }

  let resp
  try {
    resp = await connectorsHttpRequest({
      url: `${base}${CLIENT_V3}/refresh`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
  } catch (err) {
    // A network failure is not the same as a rejected token: the caller must
    // retry later rather than pushing the user into re-authentication.
    return { ok: false, reason: "network", error: err instanceof Error ? err.message : String(err) }
  }

  let parsed: {
    access_token?: string
    refresh_token?: string
    expires_in_ms?: number
    error?: string
    errcode?: string
  }
  try {
    parsed = JSON.parse(resp.body)
  } catch {
    return {
      ok: false,
      reason: resp.status >= 500 ? "network" : "rejected",
      error: `Matrix refresh returned non-JSON body (status ${resp.status})`,
    }
  }

  if (resp.status >= 500) {
    return { ok: false, reason: "network", error: `Matrix refresh ${resp.status}` }
  }
  if (resp.status < 200 || resp.status >= 300 || !parsed.access_token) {
    // 4xx means the refresh token itself is dead — only the user can fix that.
    return {
      ok: false,
      reason: "rejected",
      error: `Matrix refresh failed: ${parsed.error ?? parsed.errcode ?? `status ${resp.status}`}`,
    }
  }

  return {
    ok: true,
    accessToken: parsed.access_token,
    ...(parsed.refresh_token ? { refreshToken: parsed.refresh_token } : {}),
    ...(typeof parsed.expires_in_ms === "number" ? { expiresInMs: parsed.expires_in_ms } : {}),
  }
}

export type MatrixRefreshResult =
  | { ok: true; accessToken: string; refreshToken?: string; expiresInMs?: number }
  | {
      ok: false
      /**
       * `rejected` — the refresh token is dead; the user must sign in again.
       * `network` / `config` — transient or local; retry, do not re-auth.
       * `no_refresh_token` — this bot was configured with a bare access token.
       */
      reason: "rejected" | "network" | "config" | "no_refresh_token"
      error: string
    }

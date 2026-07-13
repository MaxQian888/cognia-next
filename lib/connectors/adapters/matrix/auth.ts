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

/**
 * Resolve the bot's own `user_id` (e.g. `@bot:matrix.org`) for an access
 * token. Returns null on any non-2xx / parse failure so the adapter can
 * still start. NOTE: an empty selfId degrades BOTH self-mention detection
 * AND own-echo suppression (the bot would answer its own messages), so the
 * adapter lazily re-probes whoami at start / during the sync loop until it
 * resolves (see index.ts `ensureSelfId`).
 */
export async function matrixWhoami(
  homeserver: string,
  accessToken: string
): Promise<string | null> {
  return (await matrixWhoamiDetailed(homeserver, accessToken))?.userId ?? null
}

export interface MatrixWhoamiResult {
  userId: string
  deviceId?: string
}

export type MatrixAccessTokenProbeResult =
  { ok: true; userId: string; deviceId?: string } | { ok: false; error: string }

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
    }),
  })

  let parsed: {
    access_token?: string
    user_id?: string
    device_id?: string
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
  }
}

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
 * still start (self-mention detection then degrades).
 */
export async function matrixWhoami(
  homeserver: string,
  accessToken: string
): Promise<string | null> {
  const base = normalizeHomeserver(homeserver)
  if (!base || !accessToken) return null
  try {
    const resp = await connectorsHttpRequest({
      url: `${base}${CLIENT_V3}/account/whoami`,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (resp.status < 200 || resp.status >= 300) return null
    const parsed = JSON.parse(resp.body) as { user_id?: string }
    return parsed.user_id ?? null
  } catch {
    return null
  }
}

export interface MatrixLoginResult {
  accessToken: string
  userId: string
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

  let parsed: { access_token?: string; user_id?: string; error?: string; errcode?: string }
  try {
    parsed = JSON.parse(resp.body)
  } catch {
    throw new Error(`Matrix login returned non-JSON body (status ${resp.status})`)
  }

  if (resp.status < 200 || resp.status >= 300 || !parsed.access_token || !parsed.user_id) {
    const reason = parsed.error ?? parsed.errcode ?? `status ${resp.status}`
    throw new Error(`Matrix login failed: ${reason}`)
  }

  return { accessToken: parsed.access_token, userId: parsed.user_id }
}

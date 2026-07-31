/**
 * Slack OAuth handler — completes the Slack OAuth code exchange path.
 *
 * The deep-link router (cognia://connector/oauth/slack?code=...&state=...)
 * invokes `handleSlackOAuth(code, {state})` after validating state. This
 * module exchanges the code for a bot token via Slack's `oauth.v2.access`
 * endpoint and persists it so the adapter's send loop can authenticate —
 * mirroring the Lark OAuth handler's shape.
 *
 *   1. Parse the adapterId out of `slack:<adapterId>:<nonce>` state.
 *   2. Resolve the AdapterInstanceRow + read clientId/clientSecret/redirectUri
 *      from the keyring.
 *   3. POST oauth.v2.access (form-encoded) for the bot token (+ optional user
 *      token).
 *   4. Store `botToken` (and `userToken` when present) in the keyring.
 *   5. Stamp connected-team metadata onto AdapterInstanceRow.settings.
 */

import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import {
  connectorsHttpRequest,
  connectorsKeyringGet,
  connectorsKeyringSet,
} from "@/lib/connectors/tauri/commands"
import { recordGrantedScopes, type ConnectedScopes } from "@/lib/connectors/oauth-scope-audit"

export function buildSlackOAuthState(adapterId: string, nonce: string): string {
  return `slack:${adapterId}:${nonce}`
}

export function parseSlackOAuthState(state: string): { adapterId: string; nonce: string } | null {
  const parts = state.split(":")
  if (parts.length < 3 || parts[0] !== "slack") return null
  const [, adapterId, ...rest] = parts
  return { adapterId, nonce: rest.join(":") }
}

export interface SlackConnectedTeam {
  teamId: string
  teamName?: string
  botUserId?: string
  authedUserId?: string
  /** Wall-clock ms the token exchange completed. */
  connectedAtMs: number
}

interface SlackOAuthAccessResponse {
  ok: boolean
  error?: string
  access_token?: string
  bot_user_id?: string
  scope?: string
  team?: { id?: string; name?: string }
  authed_user?: { id?: string; access_token?: string }
}

export interface HandleSlackOAuthDeps {
  state: string
}

/**
 * Complete the Slack OAuth exchange end-to-end. Throws on malformed state,
 * a missing adapter / client credentials, or a non-ok Slack response.
 */
export async function handleSlackOAuth(
  code: string,
  deps: HandleSlackOAuthDeps
): Promise<SlackConnectedTeam> {
  const parsed = parseSlackOAuthState(deps.state)
  if (!parsed) {
    throw new Error("Slack OAuth state malformed — expected `slack:<adapterId>:<nonce>`")
  }
  const { adapterId } = parsed

  const adapter = await getAdapterInstance(adapterId)
  if (!adapter) throw new Error(`Slack OAuth: adapter ${adapterId} not found`)
  if (adapter.type !== "slack") {
    throw new Error(
      `Slack OAuth: adapter ${adapterId} is not a Slack adapter (type=${adapter.type})`
    )
  }

  const clientId = await connectorsKeyringGet(adapterId, "clientId")
  const clientSecret = await connectorsKeyringGet(adapterId, "clientSecret")
  if (!clientId || !clientSecret) {
    throw new Error(
      `Slack OAuth: clientId/clientSecret not found in keyring (adapterId=${adapterId})`
    )
  }
  const redirectUri = String(adapter.settings.redirectUri ?? "").trim()

  const form = new URLSearchParams()
  form.set("client_id", clientId)
  form.set("client_secret", clientSecret)
  form.set("code", code)
  if (redirectUri) form.set("redirect_uri", redirectUri)

  const resp = await connectorsHttpRequest({
    url: "https://slack.com/api/oauth.v2.access",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })

  let body: SlackOAuthAccessResponse
  try {
    body = JSON.parse(resp.body)
  } catch {
    throw new Error(`Slack OAuth: oauth.v2.access returned non-JSON (status ${resp.status})`)
  }
  if (!body.ok || !body.access_token) {
    throw new Error(`Slack OAuth exchange failed: ${body.error ?? `status ${resp.status}`}`)
  }

  // The bot token is what `buildSlackAdapter` reads as `botToken`.
  await connectorsKeyringSet(adapterId, "botToken", body.access_token)
  if (body.authed_user?.access_token) {
    // "userToken" is the key `buildSlackAdapter` resolves for
    // setPresenceStatus (with a legacy fallback to the old "user_token"
    // key this handler wrote before the unification).
    await connectorsKeyringSet(adapterId, "userToken", body.authed_user.access_token)
  }

  const now = Date.now()
  const connectedTeam: SlackConnectedTeam = {
    teamId: body.team?.id ?? "",
    teamName: body.team?.name,
    botUserId: body.bot_user_id,
    authedUserId: body.authed_user?.id,
    connectedAtMs: now,
  }
  // Persist the granted scopes (and audit a change vs the prior grant) so the
  // Connections detail can show what this adapter was authorized for.
  const { connectedScopes } = await recordGrantedScopes({
    adapterId,
    raw: body.scope,
    previous: adapter.settings.connectedScopes as ConnectedScopes | undefined,
    now,
  })
  await updateAdapterInstance(adapterId, {
    settings: { ...adapter.settings, connectedTeam, connectedScopes },
    credentialsRef: {
      ...adapter.credentialsRef,
      accounts: Array.from(
        new Set([
          ...adapter.credentialsRef.accounts,
          "botToken",
          ...(body.authed_user?.access_token ? ["userToken"] : []),
        ])
      ),
    },
  })

  return connectedTeam
}

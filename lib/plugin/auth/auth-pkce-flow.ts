/**
 * Reusable OAuth 2.0 + PKCE authorization-code flow for plugin auth providers
 * (C1). Runtime-agnostic: the caller injects how to open a URL and how to
 * await the redirect (desktop/CLI use a loopback callback server; web uses a
 * popup + the `app/plugin-auth/callback` route). Reuses the Web-Crypto PKCE
 * primitives from `lib/ai/providers/oauth.ts` — no new crypto here.
 *
 * A plugin's `createSession` calls this, then wraps the result with
 * `__makeSession(...)` from the auth registry.
 */

import { generateCodeVerifier, generateCodeChallenge } from "@cognia/provider-core/providers/oauth"
import type {
  PkceFlowConfig,
  PkceTokenResult,
} from "@cognia/plugin-contract/lib/plugin/auth/auth-pkce-flow"
export type {
  PkceFlowConfig,
  PkceTokenResult,
} from "@cognia/plugin-contract/lib/plugin/auth/auth-pkce-flow"

export async function runPkceAuthFlow(config: PkceFlowConfig): Promise<PkceTokenResult> {
  const verifier = generateCodeVerifier()
  const challenge = await generateCodeChallenge(verifier)
  const state = config.state ?? generateCodeVerifier()

  const authUrl = new URL(config.authorizeUrl)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("client_id", config.clientId)
  authUrl.searchParams.set("redirect_uri", config.redirectUri)
  authUrl.searchParams.set("scope", config.scopes.join(" "))
  authUrl.searchParams.set("code_challenge", challenge)
  authUrl.searchParams.set("code_challenge_method", "S256")
  authUrl.searchParams.set("state", state)
  for (const [k, v] of Object.entries(config.extraAuthParams ?? {})) {
    authUrl.searchParams.set(k, v)
  }

  await config.openUrl(authUrl.toString())
  const { code, state: returnedState } = await config.waitForCode({
    redirectUri: config.redirectUri,
    state,
    codeVerifier: verifier,
  })
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch — possible CSRF; aborting")
  }

  const fetchImpl = config.fetchImpl ?? fetch
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  })
  for (const [k, v] of Object.entries(config.extraTokenParams ?? {})) {
    body.set(k, v)
  }
  const res = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const accessToken = json.access_token
  if (typeof accessToken !== "string") {
    throw new Error("OAuth token response missing access_token")
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    raw: json,
  }
}

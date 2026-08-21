/**
 * Google Workspace OAuth for the document provider — INSTALLED-APP LOOPBACK
 * flow with PKCE.
 *
 * Why not the device flow the Drive *backup* destination uses: Google restricts
 * "OAuth 2.0 for TV and Limited-Input Devices" to a fixed scope list — email,
 * openid, profile, `drive.appdata`, `drive.file` and the YouTube scopes. None
 * of the read scopes this provider needs are on it, so a device-code connection
 * physically cannot read a document the user already owns.
 *
 * That leaves the installed-app flow, whose only permitted redirect for a
 * Desktop client is a loopback address — hence the Rust
 * `/oauth/docs/google/callback` route on the connectors server, and hence the
 * whole provider being desktop-only.
 *
 *   1. `beginGoogleDocsAuth`    → ensure the loopback listener, mint PKCE +
 *                                 state, persist them, return the consent URL
 *   2. user consents in their browser; Google redirects to the loopback route,
 *      which bounces `cognia://docs-provider/oauth/google?code=…&state=…`
 *   3. `completeGoogleDocsAuth` → validate state, exchange the code, persist
 *                                 tokens, record the granted scopes
 *   4. `getGoogleAccessToken`   → silent refresh when the token is near expiry
 */

import {
  CODE_CHALLENGE_METHOD,
  computeCodeChallenge,
  generateCodeVerifier,
} from "@/lib/connectors/adapters/lark/pkce"
import { connectorsEnsureServer } from "@/lib/connectors/tauri/commands"
import { CONNECTORS_SERVER_PORT } from "@/lib/connectors/server-transport"
import { DocsProviderError } from "@/lib/docs-providers/types"
import {
  GOOGLE_DOCS_SCOPE_STRING,
  clearGoogleConnection,
  getGoogleClientSecret,
  getGoogleDocsSettings,
  loadGoogleTokens,
  saveGoogleTokens,
  updateGoogleDocsSettings,
  type GoogleOAuthTokens,
} from "./config"
import {
  clearGoogleOAuthPending,
  getGoogleOAuthPending,
  setGoogleOAuthPending,
} from "./oauth-pending"
import { googleHttp, parseJson, type GoogleHttpFn } from "./http"

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"

/** Refresh when fewer than this many ms of validity remain. */
export const REFRESH_SKEW_MS = 60_000

/** Path the Rust connectors router serves for document-provider callbacks. */
export const GOOGLE_CALLBACK_PATH = "/oauth/docs/google/callback"

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" }

export interface GoogleAuthDeps {
  http?: GoogleHttpFn
  now?: () => number
  /** Test seam — overrides the loopback-server bootstrap. */
  ensureServer?: (port: number) => Promise<string>
}

function form(body: Record<string, string>): string {
  return Object.entries(body)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")
}

/**
 * `google:<nonce>` — namespaced so the deep-link router can tell this apart
 * from a connector's `lark:<adapterId>:<nonce>` state.
 */
export function buildGoogleOAuthState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `google:${nonce}`
}

/**
 * Step 1 — prepare the consent URL.
 *
 * Returns the URL for the caller to open; it deliberately does not open it,
 * mirroring `beginLarkOAuth` — only the caller knows whether a browser is
 * reachable on this host.
 */
export async function beginGoogleDocsAuth(
  deps: GoogleAuthDeps = {}
): Promise<{ authorizeUrl: string; redirectUri: string }> {
  const settings = await getGoogleDocsSettings()
  const clientId = settings.clientId?.trim()
  if (!clientId) {
    throw new DocsProviderError("notConfigured", { field: "clientId" })
  }
  const clientSecret = await getGoogleClientSecret()
  if (!clientSecret) {
    throw new DocsProviderError("notConfigured", { field: "clientSecret" })
  }

  const ensure = deps.ensureServer ?? connectorsEnsureServer
  let bound: string
  try {
    bound = await ensure(CONNECTORS_SERVER_PORT)
  } catch (err) {
    throw new DocsProviderError("hostUnsupported", {
      reason: err instanceof Error ? err.message : String(err),
    })
  }
  const port = bound.split(":").pop() ?? String(CONNECTORS_SERVER_PORT)
  // Google matches loopback redirects on host+path and ignores the port, but we
  // send the real one so the redirect actually lands.
  const redirectUri = `http://127.0.0.1:${port}${GOOGLE_CALLBACK_PATH}`

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await computeCodeChallenge(codeVerifier)
  const state = buildGoogleOAuthState()
  await setGoogleOAuthPending({ state, codeVerifier, redirectUri }, deps.now?.() ?? Date.now())

  const query = form({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_DOCS_SCOPE_STRING,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CODE_CHALLENGE_METHOD,
    // Required for a refresh token: Google only issues one on the FIRST consent
    // unless the app explicitly asks to be prompted again.
    access_type: "offline",
    prompt: "consent",
  })
  return { authorizeUrl: `${GOOGLE_AUTH_URL}?${query}`, redirectUri }
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  error?: string
  error_description?: string
}

function tokensFrom(
  parsed: TokenResponse,
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

/**
 * Step 3 — exchange the authorization code.
 *
 * `state` is validated against the durable pending record (the CSRF check that
 * survives an app restart) and the record is cleared whether or not the
 * exchange succeeds, so a code can never be replayed against it.
 */
export async function completeGoogleDocsAuth(
  input: { code?: string; state?: string; error?: string; errorDescription?: string },
  deps: GoogleAuthDeps = {}
): Promise<GoogleOAuthTokens> {
  const http = deps.http ?? googleHttp
  const now = deps.now ?? Date.now

  const pending = await getGoogleOAuthPending(now())
  if (input.error) {
    await clearGoogleOAuthPending()
    throw new DocsProviderError("notAuthorized", {
      reason: input.errorDescription ?? input.error,
    })
  }
  if (!pending || !input.state || input.state !== pending.state) {
    await clearGoogleOAuthPending()
    throw new DocsProviderError("notAuthorized", { reason: "oauth state mismatch" })
  }
  if (!input.code) {
    await clearGoogleOAuthPending()
    throw new DocsProviderError("notAuthorized", { reason: "missing authorization code" })
  }

  const settings = await getGoogleDocsSettings()
  const clientId = settings.clientId?.trim()
  const clientSecret = await getGoogleClientSecret()
  if (!clientId || !clientSecret) {
    await clearGoogleOAuthPending()
    throw new DocsProviderError("notConfigured")
  }

  let response
  try {
    response = await http({
      url: GOOGLE_TOKEN_URL,
      method: "POST",
      headers: FORM_HEADERS,
      body: form({
        client_id: clientId,
        client_secret: clientSecret,
        code: input.code,
        code_verifier: pending.codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: pending.redirectUri,
      }),
    })
  } finally {
    await clearGoogleOAuthPending()
  }

  const parsed = parseJson<TokenResponse>(response.body)
  const tokens = parsed ? tokensFrom(parsed, now()) : null
  if (!tokens) {
    throw new DocsProviderError("notAuthorized", {
      reason:
        parsed?.error_description ?? parsed?.error ?? `Google returned HTTP ${response.status}`,
    })
  }
  await saveGoogleTokens(tokens)

  const email = await fetchAccountEmail(tokens.accessToken, http).catch(() => undefined)
  await updateGoogleDocsSettings((current) => ({
    ...current,
    connected: Boolean(tokens.refreshToken),
    accountEmail: email ?? current.accountEmail,
    grantedScopes: tokens.scope ?? current.grantedScopes,
  })).catch(() => undefined)
  return tokens
}

async function fetchAccountEmail(
  accessToken: string,
  http: GoogleHttpFn
): Promise<string | undefined> {
  const response = await http({
    url: GOOGLE_USERINFO_URL,
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const parsed = parseJson<{ email?: string }>(response.body)
  return parsed?.email
}

/** Exchange the stored refresh token for a fresh access token. */
export async function refreshGoogleTokens(deps: GoogleAuthDeps = {}): Promise<GoogleOAuthTokens> {
  const http = deps.http ?? googleHttp
  const now = deps.now ?? Date.now
  const stored = await loadGoogleTokens()
  if (!stored?.refreshToken) {
    throw new DocsProviderError("notAuthorized", { reason: "no refresh token" })
  }
  const settings = await getGoogleDocsSettings()
  const clientId = settings.clientId?.trim()
  const clientSecret = await getGoogleClientSecret()
  if (!clientId || !clientSecret) throw new DocsProviderError("notConfigured")

  const response = await http({
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: "refresh_token",
    }),
  })
  const parsed = parseJson<TokenResponse>(response.body)
  const tokens = parsed ? tokensFrom(parsed, now(), stored.refreshToken) : null
  if (!tokens) {
    // A refresh that fails with `invalid_grant` means the user revoked access
    // or the token aged out. Surface it as "reconnect", never as a network blip.
    throw new DocsProviderError("notAuthorized", {
      reason:
        parsed?.error_description ?? parsed?.error ?? `Google returned HTTP ${response.status}`,
    })
  }
  await saveGoogleTokens(tokens)
  return tokens
}

/** Outcome of a disconnect, for the caller to report honestly. */
export type GoogleDisconnectOutcome =
  /** Google confirmed the grant is gone. */
  | { revoked: true }
  /** Nothing was stored — local state was already clean. */
  | { revoked: false; reason: "not-connected" }
  /** Local state is cleared, but the grant may still stand at Google. */
  | { revoked: false; reason: string }

/**
 * Disconnect Google Docs: revoke the grant at Google, then drop local state.
 *
 * Clearing the keyring alone only makes the connection invisible — the refresh
 * token stays valid on Google's side, so "Disconnect" left a live grant behind
 * and the user had to go find it in their Google account settings. Revoking the
 * refresh token invalidates the whole grant (Google cascades to the access
 * tokens minted from it).
 *
 * Revocation is best-effort by design: the local clear MUST happen even when
 * the network call fails, or a user offline (or with an already-dead token)
 * could never disconnect. The outcome says which of the two happened so the UI
 * can tell the user to finish the job at Google when it matters. An already
 * invalid token answers HTTP 400 `invalid_token`, which is success for our
 * purposes — the grant is gone either way.
 */
export async function disconnectGoogleDocs(
  deps: GoogleAuthDeps = {}
): Promise<GoogleDisconnectOutcome> {
  const http = deps.http ?? googleHttp
  const stored = await loadGoogleTokens()
  if (!stored) {
    await clearGoogleConnection()
    return { revoked: false, reason: "not-connected" }
  }
  // Revoking the refresh token takes the access tokens with it; when only an
  // access token was ever issued, revoking that is all there is to revoke.
  const token = stored.refreshToken ?? stored.accessToken
  let outcome: GoogleDisconnectOutcome
  try {
    const response = await http({
      url: GOOGLE_REVOKE_URL,
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ token }),
    })
    if (response.status >= 200 && response.status < 300) {
      outcome = { revoked: true }
    } else {
      const parsed = parseJson<{ error?: string; error_description?: string }>(response.body)
      outcome =
        parsed?.error === "invalid_token"
          ? { revoked: true }
          : {
              revoked: false,
              reason:
                parsed?.error_description ??
                parsed?.error ??
                `Google returned HTTP ${response.status}`,
            }
    }
  } catch (err) {
    outcome = { revoked: false, reason: err instanceof Error ? err.message : String(err) }
  }
  await clearGoogleConnection()
  return outcome
}

/**
 * The token to use right now, refreshing silently when it is about to expire.
 * Throws `notConfigured` when the user never connected.
 */
export async function getGoogleAccessToken(deps: GoogleAuthDeps = {}): Promise<string> {
  const now = deps.now ?? Date.now
  const stored = await loadGoogleTokens()
  if (!stored) throw new DocsProviderError("notConfigured")
  if (stored.expiresAt - now() > REFRESH_SKEW_MS) return stored.accessToken
  const refreshed = await refreshGoogleTokens(deps)
  return refreshed.accessToken
}

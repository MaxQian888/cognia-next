/** Installed-app PKCE flow; credential transitions and revocation belong to the host. */
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
  getGoogleClientSecret,
  getGoogleDocsSettings,
  type GoogleOAuthTokens,
} from "./config"
import {
  googleState,
  type GoogleDisconnectOutcome as HostDisconnectOutcome,
  type GoogleConnectionState,
} from "./state"
import { googleHttp, parseJson, type GoogleHttpFn } from "./http"
import { mapGoogleStatus } from "./api"
import { setGoogleOAuthPending } from "./oauth-pending"

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

/** Refresh when fewer than this many ms of validity remain. */
export const REFRESH_SKEW_MS = 60_000

/** Path the Rust connectors router serves for document-provider callbacks. */
export const GOOGLE_CALLBACK_PATH = "/oauth/docs/google/callback"

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" }
let authorizationVersion = 0
let connectionVersion = 0
let refreshing:
  { version: number; connection: string; promise: Promise<GoogleOAuthTokens> } | undefined
export interface GoogleAuthDeps {
  http?: GoogleHttpFn
  now?: () => number
  ensureServer?: (port: number) => Promise<string>
}
function form(values: Record<string, string>) {
  return new URLSearchParams(values).toString()
}
function assertCurrent(value: boolean) {
  if (!value) throw new DocsProviderError("notAuthorized", { reason: "connection changed" })
}
export function buildGoogleOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `google:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
async function credentials() {
  const settings = await getGoogleDocsSettings()
  const clientId = settings.clientId?.trim()
  if (!clientId) throw new DocsProviderError("notConfigured", { field: "clientId" })
  const clientSecret = await getGoogleClientSecret()
  if (!clientSecret) throw new DocsProviderError("notConfigured", { field: "clientSecret" })
  return { clientId, clientSecret }
}
export async function beginGoogleDocsAuth(deps: GoogleAuthDeps = {}) {
  const version = ++authorizationVersion
  const reserved = await googleState({ action: "begin" })
  const { clientId } = await credentials()
  let bound: string
  try {
    bound = await (deps.ensureServer ?? connectorsEnsureServer)(CONNECTORS_SERVER_PORT)
  } catch (err) {
    throw new DocsProviderError("hostUnsupported", {
      reason: err instanceof Error ? err.message : String(err),
    })
  }
  const redirectUri = `http://127.0.0.1:${bound.split(":").pop()}${GOOGLE_CALLBACK_PATH}`
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await computeCodeChallenge(codeVerifier)
  const state = buildGoogleOAuthState()
  assertCurrent(version === authorizationVersion)
  // The host waits for every revoke before publishing this new pending attempt.
  await setGoogleOAuthPending(
    { state, codeVerifier, redirectUri },
    deps.now?.() ?? Date.now(),
    reserved.state.authorization
  )
  const current = (await googleState({ action: "snapshot" })).state
  assertCurrent(
    version === authorizationVersion &&
      current.authorization === reserved.state.authorization &&
      current.pending?.state === state
  )
  return {
    redirectUri,
    authorizeUrl: `${GOOGLE_AUTH_URL}?${form({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_DOCS_SCOPE_STRING,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CODE_CHALLENGE_METHOD,
      access_type: "offline",
      prompt: "consent",
    })}`,
  }
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
  parsed: TokenResponse | null,
  now: number,
  previous?: string
): GoogleOAuthTokens | null {
  if (!parsed || typeof parsed.access_token !== "string" || !parsed.access_token) return null
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? previous,
    expiresAt: now + (parsed.expires_in ?? 3600) * 1000,
    scope: parsed.scope,
    tokenType: parsed.token_type,
  }
}
export async function completeGoogleDocsAuth(
  input: { code?: string; state?: string; error?: string; errorDescription?: string },
  deps: GoogleAuthDeps = {}
): Promise<GoogleOAuthTokens> {
  const version = authorizationVersion
  const now = deps.now ?? Date.now
  const http = deps.http ?? googleHttp
  const claim = await googleState({ action: "claim", state: input.state ?? "", now: now() })
  assertCurrent(version === authorizationVersion)
  if (input.error)
    throw new DocsProviderError("notAuthorized", { reason: input.errorDescription ?? input.error })
  if (!input.code || !claim.pending)
    throw new DocsProviderError("notAuthorized", { reason: "missing authorization code" })
  const { clientId, clientSecret } = await credentials()
  assertCurrent(version === authorizationVersion)
  const response = await http({
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      code_verifier: claim.pending.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: claim.pending.redirectUri,
    }),
  })
  assertCurrent(version === authorizationVersion)
  const parsed = parseJson<TokenResponse>(response.body)
  const tokens = response.status >= 200 && response.status < 300 ? tokensFrom(parsed, now()) : null
  if (!tokens)
    throw new DocsProviderError("notAuthorized", {
      reason:
        parsed?.error_description ?? parsed?.error ?? `Google returned HTTP ${response.status}`,
    })
  const email = await http({
    url: GOOGLE_USERINFO_URL,
    method: "GET",
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  })
    .then((response) => parseJson<{ email?: string }>(response.body)?.email)
    .catch(() => undefined)
  assertCurrent(version === authorizationVersion)
  ++connectionVersion
  const committed = await googleState({
    action: "commit",
    authorization: claim.state.authorization,
    tokens,
    accountEmail: email,
  })
  const current = await googleState({ action: "snapshot" })
  assertCurrent(
    version === authorizationVersion && current.state.connection === committed.state.connection
  )
  return tokens
}
export async function refreshGoogleTokens(deps: GoogleAuthDeps = {}): Promise<GoogleOAuthTokens> {
  const version = connectionVersion
  const initial = (await googleState({ action: "snapshot" })).state
  assertCurrent(version === connectionVersion)
  return refreshForState(version, initial, deps)
}
function refreshForState(
  version: number,
  initial: GoogleConnectionState,
  deps: GoogleAuthDeps
): Promise<GoogleOAuthTokens> {
  assertCurrent(version === connectionVersion)
  if (refreshing?.version === version && refreshing.connection === initial.connection)
    return refreshing.promise
  const promise = refreshCurrent(version, deps, initial)
  const owner = { version, connection: initial.connection, promise }
  refreshing = owner
  const finish = () => {
    if (refreshing === owner) refreshing = undefined
  }
  void promise.then(finish, finish)
  return promise
}
async function refreshCurrent(
  version: number,
  deps: GoogleAuthDeps,
  initial: GoogleConnectionState
) {
  const now = deps.now ?? Date.now
  const stored = initial.tokens
  if (!stored?.refreshToken)
    throw new DocsProviderError("notAuthorized", { reason: "no refresh token" })
  const { clientId, clientSecret } = await credentials()
  assertCurrent(version === connectionVersion)
  const response = await (deps.http ?? googleHttp)({
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
  assertCurrent(version === connectionVersion)
  const parsed = parseJson<TokenResponse>(response.body)
  const tokens =
    response.status >= 200 && response.status < 300
      ? tokensFrom(parsed, now(), stored.refreshToken)
      : null
  if (!tokens) {
    if (parsed?.error === "invalid_grant") {
      await googleState({ action: "invalidate", connection: initial.connection })
      ++connectionVersion
    } else if (response.status === 429 || response.status >= 500) throw mapGoogleStatus(response)
    throw new DocsProviderError("notAuthorized", {
      reason:
        parsed?.error_description ?? parsed?.error ?? `Google returned HTTP ${response.status}`,
    })
  }
  const committed = await googleState({ action: "refresh", connection: initial.connection, tokens })
  const current = await googleState({ action: "snapshot" })
  assertCurrent(
    version === connectionVersion && current.state.connection === committed.state.connection
  )
  return tokens
}
export type GoogleDisconnectOutcome = HostDisconnectOutcome
export async function disconnectGoogleDocs(
  _deps: GoogleAuthDeps = {}
): Promise<GoogleDisconnectOutcome> {
  ++authorizationVersion
  ++connectionVersion
  const reply = await googleState({ action: "disconnect" })
  if (!reply.outcome) throw new Error("Google disconnect returned no outcome")
  return reply.outcome
}
export async function getGoogleAccessToken(deps: GoogleAuthDeps = {}) {
  const version = connectionVersion
  const initial = (await googleState({ action: "snapshot" })).state
  if (!initial.tokens) throw new DocsProviderError("notConfigured")
  assertCurrent(version === connectionVersion)
  if (initial.tokens.expiresAt - (deps.now?.() ?? Date.now()) > REFRESH_SKEW_MS)
    return initial.tokens.accessToken
  try {
    return (await refreshForState(version, initial, deps)).accessToken
  } catch (err) {
    // Another window may have refreshed the SAME connection. Never substitute
    // credentials from a later authorization or a disconnect/reconnect cycle.
    if (err instanceof DocsProviderError && err.params?.reason === "connection changed") {
      const latest = (await googleState({ action: "snapshot" })).state
      if (
        latest.authorization === initial.authorization &&
        latest.tokens &&
        latest.tokens.expiresAt - (deps.now?.() ?? Date.now()) > REFRESH_SKEW_MS
      )
        return latest.tokens.accessToken
    }
    throw err
  }
}

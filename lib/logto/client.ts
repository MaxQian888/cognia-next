/**
 * Logto login + token-refresh client (ADR-0059 cloud/headless — Logto).
 *
 * Runtime-agnostic: the caller injects `openUrl` / `waitForCode` (a CLI
 * loopback callback server — see `cli/src/mcp/oauth-callback-server.ts` — or a
 * web popup listening on the `app/plugin-auth/callback` channel) and,
 * optionally, `fetch`. All PKCE mechanics are reused from
 * `runPkceAuthFlow` (`lib/plugin/auth/auth-pkce-flow.ts`); this module only
 * layers the Logto specifics: OIDC discovery and the RFC-8707 `resource` +
 * `organization_id` indicators so the issued access token is a JWT whose
 * `aud` = the API resource (and, for org logins, carries an `organization_id`
 * claim). Those are exactly what the Rust gateway validates
 * (`src-tauri/src/companion_api/oidc.rs`).
 */

import { runPkceAuthFlow } from "@/lib/plugin/auth/auth-pkce-flow"

import { discoverLogtoEndpoints, type LogtoEndpoints } from "./discovery"

/** Base OIDC scopes: `openid` for an ID token, `offline_access` for a refresh token. */
const BASE_SCOPES = ["openid", "offline_access"] as const

export interface LogtoClientConfig {
  /** Logto OIDC issuer, e.g. `https://logto.example.com/oidc`. */
  issuer: string
  /** The Logto "native" application id for this app. */
  clientId: string
  /** Loopback (CLI/desktop) or web redirect URI registered with the app. */
  redirectUri: string
  /** API resource indicator (the gateway audience) to bind the token to. */
  resource: string
  /** Extra scopes beyond `openid` / `offline_access` (e.g. `brain:rpc`). */
  scopes?: string[]
  /** Optional Logto organization to scope the token to (→ cognia tenant). */
  organizationId?: string
  /**
   * Logto's `direct_sign_in` parameter, e.g. `social:github` or
   * `social:feishu`: skip the universal sign-in page and start with that
   * connector. The value comes from `GET /api/auth/config` discovery, never
   * from a hard-coded connector id, because the identity-provider name is
   * whatever the operator configured in the Logto console. When the connector
   * is missing or disabled, Logto falls back to its standard page.
   */
  directSignIn?: string
}

export interface LogtoDrivers {
  /** Open the authorize URL (window.open / shell open / CLI browser). */
  openUrl: (url: string) => void | Promise<void>
  /** Await the redirect and return `code`+`state`. */
  waitForCode: (params: {
    redirectUri: string
    state: string
  }) => Promise<{ code: string; state: string }>
  /** Injectable fetch (defaults to global). */
  fetchImpl?: typeof fetch
}

export interface LogtoSession {
  issuer: string
  clientId: string
  resource: string
  organizationId?: string
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** Access-token expiry (epoch ms), if the server returned `expires_in`. */
  expiresAt?: number
  /** Granted scopes, from the token response's `scope` claim. */
  scopes: string[]
}

/**
 * The non-secret half of a session: everything the UI may show about a login
 * that is no longer usable (expired, revoked, or unreachable) without holding
 * on to a token nothing should present again.
 */
export interface LogtoSessionMetadata {
  issuer: string
  clientId: string
  resource: string
  organizationId?: string
  expiresAt?: number
  scopes: string[]
}

export function toLogtoSessionMetadata(session: LogtoSession): LogtoSessionMetadata {
  const metadata: LogtoSessionMetadata = {
    issuer: session.issuer,
    clientId: session.clientId,
    resource: session.resource,
    scopes: [...session.scopes],
  }
  if (session.organizationId) metadata.organizationId = session.organizationId
  if (session.expiresAt !== undefined) metadata.expiresAt = session.expiresAt
  return metadata
}

/**
 * Why a refresh failed, in the terms a caller has to act on.
 *
 * - `invalid_grant`: the refresh token is spent, expired or revoked. Permanent.
 *   Nothing but a new interactive sign-in produces a usable token, so the
 *   stored material must be cleared.
 * - `rejected`: the issuer refused the request for another reason
 *   (`invalid_client`, a wrong `resource`, and so on). A configuration fault,
 *   not a revocation. The material is kept for a retry after the operator
 *   fixes it, and the state is an error.
 * - `server`: the issuer answered 5xx. Transient, keep the material.
 * - `network`: the issuer could not be reached. Transient, keep the material.
 *   The session is offline rather than gone.
 * - `malformed`: the issuer answered 200 with a body missing the token.
 */
export type LogtoRefreshFailureKind =
  "invalid_grant" | "rejected" | "server" | "network" | "malformed"

export class LogtoRefreshError extends Error {
  readonly kind: LogtoRefreshFailureKind
  readonly status?: number
  /** The OAuth `error` code from the response body, when there was one. */
  readonly oauthError?: string
  readonly oauthErrorDescription?: string

  constructor(
    kind: LogtoRefreshFailureKind,
    message: string,
    detail: {
      status?: number
      oauthError?: string
      oauthErrorDescription?: string
      cause?: unknown
    } = {}
  ) {
    super(message, detail.cause !== undefined ? { cause: detail.cause } : undefined)
    this.name = "LogtoRefreshError"
    this.kind = kind
    if (detail.status !== undefined) this.status = detail.status
    if (detail.oauthError) this.oauthError = detail.oauthError
    if (detail.oauthErrorDescription) this.oauthErrorDescription = detail.oauthErrorDescription
  }

  /** True when no retry can succeed and the stored refresh material is dead. */
  get permanent(): boolean {
    return this.kind === "invalid_grant"
  }

  /** True when the issuer was unreachable or unwell. The material is kept. */
  get transient(): boolean {
    return this.kind === "network" || this.kind === "server"
  }

  /**
   * The reason a permanent failure should be reported as. Logto answers
   * `invalid_grant` for both a lapsed and a revoked refresh token. The
   * description is the only place it says which.
   */
  get reauthReason(): "expired" | "revoked" {
    return /expired|exp\b/i.test(this.oauthErrorDescription ?? "") ? "expired" : "revoked"
  }
}

export function isLogtoRefreshError(error: unknown): error is LogtoRefreshError {
  return error instanceof LogtoRefreshError
}

function mergeScopes(extra?: string[]): string[] {
  const set = new Set<string>([...BASE_SCOPES, ...(extra ?? [])])
  return [...set]
}

function grantedScopes(raw: Record<string, unknown>, fallback: string[]): string[] {
  return typeof raw.scope === "string" ? raw.scope.split(/\s+/).filter(Boolean) : fallback
}

/** Interactive authorization-code + PKCE login against Logto. */
export async function loginToLogto(
  config: LogtoClientConfig,
  drivers: LogtoDrivers
): Promise<LogtoSession> {
  const fetchImpl = drivers.fetchImpl ?? fetch
  const endpoints = await discoverLogtoEndpoints(config.issuer, fetchImpl)
  const scopes = mergeScopes(config.scopes)

  const extraTokenParams: Record<string, string> = { resource: config.resource }
  if (config.organizationId) extraTokenParams.organization_id = config.organizationId
  const extraAuthParams: Record<string, string> = { resource: config.resource }
  if (config.directSignIn) extraAuthParams.direct_sign_in = config.directSignIn

  const result = await runPkceAuthFlow({
    authorizeUrl: endpoints.authorizationEndpoint,
    tokenUrl: endpoints.tokenEndpoint,
    clientId: config.clientId,
    scopes,
    redirectUri: config.redirectUri,
    openUrl: drivers.openUrl,
    waitForCode: drivers.waitForCode,
    fetchImpl,
    extraAuthParams,
    extraTokenParams,
  })

  return {
    issuer: endpoints.issuer,
    clientId: config.clientId,
    resource: config.resource,
    organizationId: config.organizationId,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    idToken: typeof result.raw.id_token === "string" ? result.raw.id_token : undefined,
    expiresAt: result.expiresAt,
    scopes: grantedScopes(result.raw, scopes),
  }
}

/**
 * Exchange a refresh token for a fresh access token. The response often omits
 * a new `refresh_token`; in that case the supplied one is preserved.
 *
 * Every failure is a {@link LogtoRefreshError} whose `kind` says whether the
 * stored material is dead (`invalid_grant`) or merely unusable right now. An
 * untyped throw here used to make "the network is down" and "your login was
 * revoked" the same event, and the caller had to guess which one it was.
 */
export async function refreshLogtoToken(
  config: LogtoClientConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<LogtoSession> {
  let endpoints: LogtoEndpoints
  try {
    endpoints = await discoverLogtoEndpoints(config.issuer, fetchImpl)
  } catch (error) {
    throw classifyTransportFailure(error, "Logto OIDC discovery failed")
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    resource: config.resource,
  })
  if (config.organizationId) body.set("organization_id", config.organizationId)

  let res: Response
  try {
    res = await fetchImpl(endpoints.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    })
  } catch (error) {
    throw classifyTransportFailure(error, "Logto token refresh failed")
  }
  if (!res.ok) {
    throw await classifyRefreshRejection(res)
  }
  let json: Record<string, unknown>
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch (error) {
    throw new LogtoRefreshError("malformed", "Logto refresh response is not JSON", {
      status: res.status,
      cause: error,
    })
  }
  const accessToken = json.access_token
  if (typeof accessToken !== "string") {
    throw new LogtoRefreshError("malformed", "Logto refresh response missing access_token", {
      status: res.status,
    })
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined

  return {
    issuer: endpoints.issuer,
    clientId: config.clientId,
    resource: config.resource,
    organizationId: config.organizationId,
    accessToken,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : refreshToken,
    idToken: typeof json.id_token === "string" ? json.id_token : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    scopes: grantedScopes(json, []),
  }
}

/** A thrown `fetch` is the network. Anything else on the way is the server. */
function classifyTransportFailure(error: unknown, prefix: string): LogtoRefreshError {
  const message = error instanceof Error ? error.message : String(error)
  // `discoverLogtoEndpoints` turns a non-2xx discovery answer into an Error
  // that names the status. That is the issuer misbehaving, not the network.
  const kind: LogtoRefreshFailureKind = /discovery failed: \d{3}/.test(message)
    ? "server"
    : "network"
  return new LogtoRefreshError(kind, `${prefix}: ${message}`, { cause: error })
}

async function classifyRefreshRejection(res: Response): Promise<LogtoRefreshError> {
  let oauthError: string | undefined
  let oauthErrorDescription: string | undefined
  try {
    const parsed = (await res.json()) as Record<string, unknown>
    if (typeof parsed.error === "string") oauthError = parsed.error
    if (typeof parsed.error_description === "string") {
      oauthErrorDescription = parsed.error_description
    }
  } catch {
    // A non-JSON error body is still an error. The status carries the class.
  }
  const detail = { status: res.status, oauthError, oauthErrorDescription }
  const summary = `Logto token refresh failed: ${res.status} ${res.statusText}${
    oauthError ? ` (${oauthError})` : ""
  }`
  if (res.status >= 500) return new LogtoRefreshError("server", summary, detail)
  if (oauthError === "invalid_grant") return new LogtoRefreshError("invalid_grant", summary, detail)
  return new LogtoRefreshError("rejected", summary, detail)
}

export type LogtoRevocationOutcome =
  /** The issuer accepted the revocation (RFC 7009 answers 200 even for a token it never issued). */
  | { status: "revoked" }
  /** The issuer advertises no revocation endpoint, so there is nothing to call. */
  | { status: "unsupported" }
  /** The call did not go through. The token may still be live at the issuer. */
  | { status: "failed"; reason: string }

/**
 * Revoke a token at the issuer (RFC 7009).
 *
 * Never throws: a sign-out has to finish clearing local material whether or
 * not the issuer could be reached, and the outcome is reported so the caller
 * can say "signed out here, but the issuer may still hold a session".
 */
export async function revokeLogtoToken(
  config: Pick<LogtoClientConfig, "issuer" | "clientId">,
  token: string,
  tokenTypeHint: "refresh_token" | "access_token",
  fetchImpl: typeof fetch = fetch
): Promise<LogtoRevocationOutcome> {
  let endpoints: LogtoEndpoints
  try {
    endpoints = await discoverLogtoEndpoints(config.issuer, fetchImpl)
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
  if (!endpoints.revocationEndpoint) return { status: "unsupported" }

  const body = new URLSearchParams({
    token,
    token_type_hint: tokenTypeHint,
    client_id: config.clientId,
  })
  try {
    const res = await fetchImpl(endpoints.revocationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    })
    if (!res.ok) {
      return {
        status: "failed",
        reason: `Logto revocation failed: ${res.status} ${res.statusText}`,
      }
    }
    return { status: "revoked" }
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The RP-initiated logout URL for a session, or `null` when the issuer has no
 * `end_session_endpoint`. Opening it in a browser ends the issuer's own login
 * cookie, which token revocation alone does not. The next authorize call
 * would otherwise sign the same person straight back in without asking.
 */
export function buildLogtoEndSessionUrl(
  endpoints: Pick<LogtoEndpoints, "endSessionEndpoint">,
  input: { idToken?: string; clientId: string; postLogoutRedirectUri?: string }
): string | null {
  if (!endpoints.endSessionEndpoint) return null
  const url = new URL(endpoints.endSessionEndpoint)
  url.searchParams.set("client_id", input.clientId)
  if (input.idToken) url.searchParams.set("id_token_hint", input.idToken)
  if (input.postLogoutRedirectUri) {
    url.searchParams.set("post_logout_redirect_uri", input.postLogoutRedirectUri)
  }
  return url.toString()
}

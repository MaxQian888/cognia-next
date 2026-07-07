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

import { discoverLogtoEndpoints } from "./discovery"

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

  const result = await runPkceAuthFlow({
    authorizeUrl: endpoints.authorizationEndpoint,
    tokenUrl: endpoints.tokenEndpoint,
    clientId: config.clientId,
    scopes,
    redirectUri: config.redirectUri,
    openUrl: drivers.openUrl,
    waitForCode: drivers.waitForCode,
    fetchImpl,
    extraAuthParams: { resource: config.resource },
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
 */
export async function refreshLogtoToken(
  config: LogtoClientConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<LogtoSession> {
  const endpoints = await discoverLogtoEndpoints(config.issuer, fetchImpl)

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    resource: config.resource,
  })
  if (config.organizationId) body.set("organization_id", config.organizationId)

  const res = await fetchImpl(endpoints.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new Error(`Logto token refresh failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const accessToken = json.access_token
  if (typeof accessToken !== "string") {
    throw new Error("Logto refresh response missing access_token")
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

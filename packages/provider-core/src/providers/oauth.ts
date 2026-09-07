/**
 * OAuth utilities for AI provider authentication.
 * Provider behavior is driven by config/providers/*.json oauthConfig.
 */

import { nanoid } from "nanoid"
import {
  getAllProviders,
  type OAuthConfig,
  type OAuthRuleTransform,
  type OAuthRuleValue,
} from "@cognia/provider-types"
import { getProviderCoreLogger, proxyFetch } from "./runtime-adapters"

const log = getProviderCoreLogger("ai")

// PKCE Challenge Generation
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return base64UrlEncode(array)
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return base64UrlEncode(new Uint8Array(digest))
}

function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer))
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// OAuth State Management
export interface OAuthState {
  state: string
  codeVerifier: string
  providerId: string
  redirectUri: string
  createdAt: number
}

const OAUTH_STATE_KEY = "cognia-oauth-state"
const OAUTH_STATE_EXPIRY = 10 * 60 * 1000 // 10 minutes

export function saveOAuthState(oauthState: OAuthState): void {
  if (typeof window === "undefined") return
  localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify(oauthState))
}

export function getOAuthState(): OAuthState | null {
  if (typeof window === "undefined") return null
  const stored = localStorage.getItem(OAUTH_STATE_KEY)
  if (!stored) return null

  try {
    const state = JSON.parse(stored) as OAuthState
    if (Date.now() - state.createdAt > OAUTH_STATE_EXPIRY) {
      clearOAuthState()
      return null
    }
    return state
  } catch {
    return null
  }
}

export function clearOAuthState(): void {
  if (typeof window === "undefined") return
  localStorage.removeItem(OAUTH_STATE_KEY)
}

export interface ProviderOAuthConfig extends OAuthConfig {
  providerId: string
}

type ResolveContext = {
  input?: Record<string, unknown>
  runtime?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: Record<string, unknown>
}

type OAuthCallbackPayload = Record<string, string | null | undefined>

type OAuthExchangeResult = {
  apiKey: string
  expiresAt?: number
  [key: string]: string | number | boolean | null | undefined
}

function getByPath(target: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current == null || typeof current !== "object") {
      return undefined
    }
    return (current as Record<string, unknown>)[segment]
  }, target)
}

function applyTransforms(value: unknown, transforms?: OAuthRuleTransform[]): unknown {
  if (!transforms || transforms.length === 0) {
    return value
  }

  return transforms.reduce<unknown>((current, transform) => {
    switch (transform) {
      case "to-string":
        return current == null ? "" : String(current)
      case "to-number":
        return current == null || current === "" ? undefined : Number(current)
      case "to-boolean":
        if (typeof current === "boolean") return current
        if (typeof current === "string") {
          return current === "true" || current === "1"
        }
        return Boolean(current)
      default:
        return current
    }
  }, value)
}

function resolveRuleValue(rule: OAuthRuleValue, context: ResolveContext): unknown {
  const raw = "literal" in rule ? rule.literal : getByPath(context, rule.from)
  return applyTransforms(raw, rule.transforms)
}

function resolveRuleMap(
  rules: Record<string, OAuthRuleValue> | undefined,
  context: ResolveContext
): Record<string, unknown> {
  if (!rules) return {}

  return Object.fromEntries(
    Object.entries(rules)
      .map(([key, rule]) => [key, resolveRuleValue(rule, context)] as const)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
  )
}

function coerceStringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
}

function resolveRedirectUri(callbackPath: string): string {
  if (typeof window === "undefined") return callbackPath
  return new URL(callbackPath, window.location.origin).toString()
}

function getDefaultCallbackExtractConfig(): Record<string, string> {
  return {
    code: "query.code",
    error: "query.error",
    state: "query.state",
  }
}

function getDefaultExchangeBody(config: ProviderOAuthConfig): Record<string, OAuthRuleValue> {
  const body: Record<string, OAuthRuleValue> = {
    code: { from: "input.code" },
  }

  if (config.pkceRequired) {
    body.code_verifier = { from: "input.codeVerifier" }
    body.code_challenge_method = { literal: "S256" }
  }

  return body
}

function getDefaultAuthorizationParams(
  config: ProviderOAuthConfig
): Record<string, OAuthRuleValue> {
  const params: Record<string, OAuthRuleValue> = {
    state: { from: "runtime.state" },
    // Where the IdP sends the user back. This was missing entirely, so the
    // authorize URL never named a callback and OpenRouter rejected the flow
    // before the user saw a consent screen.
    [config.redirectUriParam ?? "redirect_uri"]: { from: "runtime.redirectUri" },
  }

  if (config.clientId) {
    params.client_id = { literal: config.clientId }
  }

  if (config.scope) {
    params.scope = { literal: config.scope }
  }

  if (config.pkceRequired) {
    params.code_challenge = { from: "runtime.codeChallenge" }
    params.code_challenge_method = { literal: "S256" }
  }

  return params
}

export function getProviderOAuthConfig(providerId: string): ProviderOAuthConfig | null {
  const provider = getAllProviders()[providerId]
  if (!provider?.supportsOAuth || !provider.oauthConfig) {
    return null
  }

  return {
    providerId,
    ...provider.oauthConfig,
  }
}

export const OAUTH_PROVIDERS: Record<string, ProviderOAuthConfig> = Object.fromEntries(
  Object.values(getAllProviders())
    .filter((provider) => provider.supportsOAuth && provider.oauthConfig)
    .map((provider) => [
      provider.id,
      {
        providerId: provider.id,
        ...provider.oauthConfig!,
      },
    ])
)

export interface BuildOAuthUrlOptions {
  /**
   * Host-resolved redirect URI. Desktop / mobile shells pass their
   * `cognia://provider/oauth/<id>` deep link, the web build a real route on
   * its origin; omitted → `callbackPath` resolved against the current origin.
   */
  redirectUri?: string
}

/**
 * The deep-link the native shells hand to the IdP as the redirect target. The
 * shells' deep-link plumbing (`ConnectorDeepLinkRouter` pattern) delivers the
 * final `cognia://provider/oauth/<id>?code=…` URL back to the renderer.
 */
export function buildNativeOAuthRedirectUri(providerId: string): string {
  return `cognia://provider/oauth/${encodeURIComponent(providerId)}`
}

/** Matches `cognia://provider/oauth/<id>?code=…` and returns the provider id. */
export function parseNativeOAuthDeepLink(
  raw: string
): { providerId: string; search: URLSearchParams } | null {
  const match = /^cognia:\/\/provider\/oauth\/([^?#/]+)/.exec(raw)
  if (!match) return null
  let url: URL
  try {
    // URL needs an http-ish base to parse the query string.
    url = new URL(raw.replace(/^cognia:\/\//, "https://cognia-placeholder/"))
  } catch {
    return null
  }
  return { providerId: decodeURIComponent(match[1]), search: url.searchParams }
}

export async function buildOAuthUrl(
  providerId: string,
  options: BuildOAuthUrlOptions = {}
): Promise<{
  url: string
  state: OAuthState
} | null> {
  const config = getProviderOAuthConfig(providerId)
  if (!config) return null

  const state = nanoid(32)
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = config.pkceRequired ? await generateCodeChallenge(codeVerifier) : undefined
  const redirectUri = options.redirectUri ?? resolveRedirectUri(config.callbackPath)

  const oauthState: OAuthState = {
    state,
    codeVerifier,
    providerId,
    redirectUri,
    createdAt: Date.now(),
  }

  saveOAuthState(oauthState)

  const runtime = {
    providerId,
    state,
    codeVerifier,
    codeChallenge,
    redirectUri,
    origin: typeof window !== "undefined" ? window.location.origin : undefined,
  }
  const paramsConfig = config.authorizationParams ?? getDefaultAuthorizationParams(config)
  const resolvedParams = resolveRuleMap(paramsConfig, { runtime })
  const params = new URLSearchParams(coerceStringRecord(resolvedParams))

  return {
    url: `${config.authorizationUrl}?${params.toString()}`,
    state: oauthState,
  }
}

export function parseOAuthCallback(
  providerId: string,
  search: string | URLSearchParams
): OAuthCallbackPayload | null {
  const config = getProviderOAuthConfig(providerId)
  if (!config) return null

  const params =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : search
  const extractConfig = config.callback?.extract ?? getDefaultCallbackExtractConfig()

  const query = Object.fromEntries(params.entries())
  return Object.fromEntries(
    Object.entries(extractConfig).map(([key, path]) => {
      const value = getByPath({ query }, path)
      return [key, value == null ? null : String(value)]
    })
  )
}

export function getOAuthCallbackQueryKeys(providerId: string): string[] {
  const config = getProviderOAuthConfig(providerId)
  if (!config) return []

  const extractConfig = config.callback?.extract ?? getDefaultCallbackExtractConfig()
  return Array.from(
    new Set(
      Object.values(extractConfig)
        .filter((path) => path.startsWith("query."))
        .map((path) => path.slice("query.".length))
    )
  )
}

export function buildOAuthExchangeRequest(
  providerId: string,
  input: Record<string, unknown>
): { url: string; init: RequestInit } | null {
  const config = getProviderOAuthConfig(providerId)
  if (!config) return null

  const headersConfig = config.exchange?.headers ?? {
    "Content-Type": { literal: "application/json" },
  }
  const bodyConfig = config.exchange?.body ?? getDefaultExchangeBody(config)
  const method = config.exchange?.method ?? "POST"

  const resolvedHeaders = coerceStringRecord(resolveRuleMap(headersConfig, { input }))
  const resolvedBody = resolveRuleMap(bodyConfig, { input })
  const init: RequestInit = {
    method,
    headers: resolvedHeaders,
  }

  if (method !== "GET") {
    init.body = JSON.stringify(resolvedBody)
  }

  return {
    url: config.tokenUrl,
    init,
  }
}

export function extractOAuthExchangeResult(
  providerId: string,
  responseBody: unknown
): OAuthExchangeResult | null {
  const config = getProviderOAuthConfig(providerId)
  if (!config) return null

  const mapping = config.exchange?.response ?? {
    apiKey: "body.apiKey",
    expiresAt: "body.expiresAt",
  }

  const extracted = Object.fromEntries(
    Object.entries(mapping).map(([key, path]) => [key, getByPath({ body: responseBody }, path)])
  )

  const apiKey = extracted.apiKey
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return null
  }

  const result: OAuthExchangeResult = {
    apiKey,
  }

  for (const [key, value] of Object.entries(extracted)) {
    if (key === "apiKey" || value === undefined) continue
    if (key === "expiresAt" && value != null) {
      result.expiresAt = typeof value === "number" ? value : Number(value)
      continue
    }
    result[key] = value as OAuthExchangeResult[string]
  }

  return result
}

/**
 * Exchange the authorization code straight against the provider's token
 * endpoint (`tokenUrl`) using the catalog's exchange spec. This used to POST
 * to `/api/oauth/:id/exchange` — a Next.js API route that does not exist in
 * the static export, so the flow could never complete on any shipped host.
 */
export async function exchangeCodeForApiKey(
  providerId: string,
  payload: { code: string; codeVerifier?: string }
): Promise<OAuthCredential | null> {
  try {
    const request = buildOAuthExchangeRequest(providerId, payload)
    if (!request) return null
    const response = await proxyFetch(request.url, request.init)

    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (!response.ok) {
      const error = (body ?? {}) as { message?: string; error?: string | { message?: string } }
      const detail =
        typeof error.error === "string"
          ? error.error
          : (error.error?.message ?? error.message ?? `HTTP ${response.status}`)
      throw new Error(`Failed to exchange code for API key: ${detail}`)
    }

    const extracted = extractOAuthExchangeResult(providerId, body)
    if (extracted) {
      return {
        apiKey: extracted.apiKey,
        expiresAt: extracted.expiresAt,
        // Carried through so a short-lived credential can be renewed. Dropping
        // it here used to mean any provider issuing a one-hour token worked
        // until its first expiry and then had no recovery but a fresh login.
        refreshToken:
          typeof extracted.refreshToken === "string" ? extracted.refreshToken : undefined,
      }
    }
    // Lenient fallbacks for providers whose response mapping is not spelled out.
    const loose = (body ?? {}) as {
      apiKey?: string
      key?: string
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    const apiKey = loose.apiKey ?? loose.key ?? loose.access_token
    if (!apiKey) return null
    return {
      apiKey,
      refreshToken: loose.refresh_token,
      expiresAt:
        typeof loose.expires_in === "number" ? Date.now() + loose.expires_in * 1000 : undefined,
    }
  } catch (error) {
    log.error("OAuth exchange failed", error as Error)
    return null
  }
}

export function verifyOAuthState(returnedState: string): OAuthState | null {
  const storedState = getOAuthState()
  if (!storedState || storedState.state !== returnedState) {
    return null
  }
  return storedState
}

/**
 * A credential obtained from an OAuth login.
 *
 * `apiKey` is what every provider call actually sends. `refreshToken` and
 * `expiresAt` are present only for providers that issue short-lived tokens.
 */
export interface OAuthCredential {
  apiKey: string
  expiresAt?: number
  refreshToken?: string
}

/** Renew this far ahead of the stated expiry rather than waiting for a 401. */
export const OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000

/**
 * Whether a credential is close enough to expiry to be worth renewing.
 * A credential with no stated expiry never expires as far as we know.
 */
export function isOAuthCredentialExpiring(
  expiresAt: number | undefined,
  now: number = Date.now(),
  bufferMs: number = OAUTH_REFRESH_BUFFER_MS
): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return false
  return expiresAt - now <= bufferMs
}

function getDefaultRefreshBody(config: ProviderOAuthConfig): Record<string, OAuthRuleValue> {
  const body: Record<string, OAuthRuleValue> = {
    grant_type: { literal: "refresh_token" },
    refresh_token: { from: "input.refreshToken" },
  }
  if (config.clientId) body.client_id = { literal: config.clientId }
  return body
}

/**
 * Trade a refresh token for a fresh credential, against the PROVIDER's own
 * endpoint.
 *
 * The previous implementation posted to `/api/oauth/:id/refresh`. The app is a
 * static export, so `app/api/` does not exist at runtime and that request
 * 404'd on every shell. It was also unreachable: it read its refresh token
 * from a localStorage key that nothing ever wrote.
 *
 * Returns `null` when the provider declares no refresh spec, or when the
 * exchange fails. Callers decide whether that means "re-login" or "retry
 * later" and are expected to back off rather than loop.
 */
export async function refreshOAuthCredential(
  providerId: string,
  payload: { refreshToken: string }
): Promise<OAuthCredential | null> {
  const config = getProviderOAuthConfig(providerId)
  if (!config?.refresh) return null
  if (!payload.refreshToken) return null

  const spec = config.refresh
  const url = spec.url ?? config.tokenUrl
  const headers = coerceStringRecord(
    resolveRuleMap(spec.headers ?? { "Content-Type": { literal: "application/json" } }, {
      input: payload,
    })
  )
  const body = resolveRuleMap(spec.body ?? getDefaultRefreshBody(config), { input: payload })
  const method = spec.method ?? "POST"

  const init: RequestInit = { method, headers }
  if (method !== "GET") {
    init.body = isFormEncoded(headers)
      ? new URLSearchParams(coerceStringRecord(body)).toString()
      : JSON.stringify(body)
  }

  const response = await proxyFetch(url, init)
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  if (!response.ok) {
    throw new Error(`${response.status}: ${describeOAuthError(parsed)}`)
  }

  const mapping = spec.response ?? config.exchange?.response
  const extracted = mapping
    ? Object.fromEntries(
        Object.entries(mapping).map(([key, path]) => [key, getByPath({ body: parsed }, path)])
      )
    : {}
  const loose = (parsed ?? {}) as {
    access_token?: string
    key?: string
    apiKey?: string
    refresh_token?: string
    expires_in?: number
  }

  const apiKey =
    typeof extracted.apiKey === "string" && extracted.apiKey
      ? extracted.apiKey
      : (loose.access_token ?? loose.key ?? loose.apiKey)
  if (!apiKey) return null

  const refreshToken =
    typeof extracted.refreshToken === "string" && extracted.refreshToken
      ? extracted.refreshToken
      : // A provider that does not rotate its refresh token simply omits it,
        // and the caller must keep spending the one it already holds.
        (loose.refresh_token ?? payload.refreshToken)

  // `expiresAt` means the same thing on both halves of the flow: the ABSOLUTE
  // epoch-ms stamp `extractOAuthExchangeResult` reads out of the very same
  // `exchange.response` mapping. Guessing a unit from the magnitude here would
  // give one declared field two meanings. A mapping onto an epoch-SECONDS
  // field would then be stored as 1970 by the login and as 2082 by the
  // renewal, so the credential would either look permanently expired or never
  // expire. Only the unmapped RFC 6749 `expires_in` fallback is a relative
  // delta, and it is read as one here.
  const mappedExpiresAt =
    extracted.expiresAt == null
      ? undefined
      : typeof extracted.expiresAt === "number"
        ? extracted.expiresAt
        : Number(extracted.expiresAt)
  const expiresAt =
    mappedExpiresAt !== undefined && Number.isFinite(mappedExpiresAt)
      ? mappedExpiresAt
      : typeof loose.expires_in === "number" && Number.isFinite(loose.expires_in)
        ? Date.now() + loose.expires_in * 1000
        : undefined

  return { apiKey, refreshToken, expiresAt }
}

/** True when the resolved headers ask for a form-encoded body. */
export function isFormEncoded(headers: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") {
      return value.toLowerCase().includes("application/x-www-form-urlencoded")
    }
  }
  return false
}

/** Pull the most human-readable message out of an OAuth error body. */
export function describeOAuthError(body: unknown): string {
  if (!body || typeof body !== "object") return "unknown error"
  const record = body as {
    error?: string | { message?: string }
    error_description?: string
    message?: string
  }
  if (typeof record.error_description === "string") return record.error_description
  if (typeof record.error === "string") return record.error
  if (record.error && typeof record.error === "object" && record.error.message) {
    return record.error.message
  }
  if (typeof record.message === "string") return record.message
  return "unknown error"
}

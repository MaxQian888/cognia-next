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
import { getProviderCoreLogger } from "./runtime-adapters"

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

export async function buildOAuthUrl(providerId: string): Promise<{
  url: string
  state: OAuthState
} | null> {
  const config = getProviderOAuthConfig(providerId)
  if (!config) return null

  const state = nanoid(32)
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = config.pkceRequired ? await generateCodeChallenge(codeVerifier) : undefined
  const redirectUri = resolveRedirectUri(config.callbackPath)

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

export async function exchangeCodeForApiKey(
  providerId: string,
  payload: { code: string; codeVerifier?: string }
): Promise<{ apiKey: string; expiresAt?: number } | null> {
  try {
    const response = await fetch(`/api/oauth/${providerId}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.message || error.error || "Failed to exchange code for API key")
    }

    const data = await response.json()
    return {
      apiKey: data.apiKey || data.key,
      expiresAt: data.expiresAt,
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

// Token expiration constants
const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000
const TOKEN_EXPIRY_STORAGE_KEY = "cognia-oauth-token-expiry"

interface TokenExpiryInfo {
  providerId: string
  expiresAt: number
  refreshToken?: string
}

export function saveTokenExpiry(
  providerId: string,
  expiresAt: number,
  refreshToken?: string
): void {
  if (typeof window === "undefined") return
  const key = `${TOKEN_EXPIRY_STORAGE_KEY}-${providerId}`
  const info: TokenExpiryInfo = { providerId, expiresAt, refreshToken }
  localStorage.setItem(key, JSON.stringify(info))
}

export function getTokenExpiry(providerId: string): TokenExpiryInfo | null {
  if (typeof window === "undefined") return null
  const key = `${TOKEN_EXPIRY_STORAGE_KEY}-${providerId}`
  const stored = localStorage.getItem(key)
  if (!stored) return null

  try {
    return JSON.parse(stored) as TokenExpiryInfo
  } catch {
    return null
  }
}

export function clearTokenExpiry(providerId: string): void {
  if (typeof window === "undefined") return
  const key = `${TOKEN_EXPIRY_STORAGE_KEY}-${providerId}`
  localStorage.removeItem(key)
}

export function isTokenExpiringSoon(providerId: string): boolean {
  const expiryInfo = getTokenExpiry(providerId)
  if (!expiryInfo?.expiresAt) return false
  return expiryInfo.expiresAt - Date.now() <= TOKEN_REFRESH_BUFFER
}

export function isTokenExpired(providerId: string): boolean {
  const expiryInfo = getTokenExpiry(providerId)
  if (!expiryInfo?.expiresAt) return false
  return Date.now() >= expiryInfo.expiresAt
}

export function getTokenTimeToExpiry(providerId: string): number | null {
  const expiryInfo = getTokenExpiry(providerId)
  if (!expiryInfo?.expiresAt) return null
  const remaining = expiryInfo.expiresAt - Date.now()
  return remaining > 0 ? remaining : 0
}

export async function refreshOAuthToken(
  providerId: string
): Promise<{ apiKey: string; expiresAt?: number } | null> {
  const expiryInfo = getTokenExpiry(providerId)
  if (!expiryInfo?.refreshToken) {
    log.warn("No refresh token available for provider", { providerId })
    return null
  }

  try {
    const response = await fetch(`/api/oauth/${providerId}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: expiryInfo.refreshToken }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.message || "Failed to refresh token")
    }

    const data = await response.json()

    if (data.expiresAt) {
      saveTokenExpiry(providerId, data.expiresAt, data.refreshToken || expiryInfo.refreshToken)
    }

    return {
      apiKey: data.apiKey || data.key,
      expiresAt: data.expiresAt,
    }
  } catch (error) {
    log.error("OAuth token refresh failed", error as Error)
    return null
  }
}

export async function ensureValidToken(
  providerId: string,
  onRefresh?: (newApiKey: string) => void
): Promise<boolean> {
  if (!isTokenExpiringSoon(providerId)) {
    return true
  }

  if (isTokenExpired(providerId)) {
    log.info("Token expired, attempting refresh", { providerId })
  } else {
    log.info("Token expiring soon, proactively refreshing", { providerId })
  }

  const result = await refreshOAuthToken(providerId)
  if (result) {
    log.info("Token refreshed successfully", { providerId })
    onRefresh?.(result.apiKey)
    return true
  }

  log.warn("Token refresh failed", { providerId })
  return false
}

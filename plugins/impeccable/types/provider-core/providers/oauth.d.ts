import { OAuthConfig } from "@cognia/provider-types"

/**
 * OAuth utilities for AI provider authentication.
 * Provider behavior is driven by config/providers/*.json oauthConfig.
 */

declare function generateCodeVerifier(): string
declare function generateCodeChallenge(verifier: string): Promise<string>
interface OAuthState {
  state: string
  codeVerifier: string
  providerId: string
  redirectUri: string
  createdAt: number
}
declare function saveOAuthState(oauthState: OAuthState): void
declare function getOAuthState(): OAuthState | null
declare function clearOAuthState(): void
interface ProviderOAuthConfig extends OAuthConfig {
  providerId: string
}
type OAuthCallbackPayload = Record<string, string | null | undefined>
type OAuthExchangeResult = {
  apiKey: string
  expiresAt?: number
  [key: string]: string | number | boolean | null | undefined
}
declare function getProviderOAuthConfig(providerId: string): ProviderOAuthConfig | null
declare const OAUTH_PROVIDERS: Record<string, ProviderOAuthConfig>
declare function buildOAuthUrl(providerId: string): Promise<{
  url: string
  state: OAuthState
} | null>
declare function parseOAuthCallback(
  providerId: string,
  search: string | URLSearchParams
): OAuthCallbackPayload | null
declare function getOAuthCallbackQueryKeys(providerId: string): string[]
declare function buildOAuthExchangeRequest(
  providerId: string,
  input: Record<string, unknown>
): {
  url: string
  init: RequestInit
} | null
declare function extractOAuthExchangeResult(
  providerId: string,
  responseBody: unknown
): OAuthExchangeResult | null
declare function exchangeCodeForApiKey(
  providerId: string,
  payload: {
    code: string
    codeVerifier?: string
  }
): Promise<{
  apiKey: string
  expiresAt?: number
} | null>
declare function verifyOAuthState(returnedState: string): OAuthState | null
interface TokenExpiryInfo {
  providerId: string
  expiresAt: number
  refreshToken?: string
}
declare function saveTokenExpiry(providerId: string, expiresAt: number, refreshToken?: string): void
declare function getTokenExpiry(providerId: string): TokenExpiryInfo | null
declare function clearTokenExpiry(providerId: string): void
declare function isTokenExpiringSoon(providerId: string): boolean
declare function isTokenExpired(providerId: string): boolean
declare function getTokenTimeToExpiry(providerId: string): number | null
declare function refreshOAuthToken(providerId: string): Promise<{
  apiKey: string
  expiresAt?: number
} | null>
declare function ensureValidToken(
  providerId: string,
  onRefresh?: (newApiKey: string) => void
): Promise<boolean>

export {
  OAUTH_PROVIDERS,
  type OAuthState,
  type ProviderOAuthConfig,
  buildOAuthExchangeRequest,
  buildOAuthUrl,
  clearOAuthState,
  clearTokenExpiry,
  ensureValidToken,
  exchangeCodeForApiKey,
  extractOAuthExchangeResult,
  generateCodeChallenge,
  generateCodeVerifier,
  getOAuthCallbackQueryKeys,
  getOAuthState,
  getProviderOAuthConfig,
  getTokenExpiry,
  getTokenTimeToExpiry,
  isTokenExpired,
  isTokenExpiringSoon,
  parseOAuthCallback,
  refreshOAuthToken,
  saveOAuthState,
  saveTokenExpiry,
  verifyOAuthState,
}

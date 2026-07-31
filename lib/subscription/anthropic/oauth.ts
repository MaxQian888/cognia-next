// PKCE OAuth flow for Claude (subscription / console). Three pure-ish entry
// points:
//
//   buildAuthorizeUrl({ mode })          — assemble the URL the user opens
//   exchangeCodeForTokens({ ... })       — swap code+verifier → tokens
//   refreshAccessToken({ ... })          — swap refresh_token → tokens
//
// PKCE primitives are reused from `lib/ai/providers/oauth.ts`; we only add
// Anthropic-specific packing/parsing. The token endpoint speaks
// `application/x-www-form-urlencoded` (NOT JSON — JSON returns 400
// invalid_grant per [coqu OAuth notes](https://flopsstuff.github.io/coqu/claude-oauth/)).
//
// The server may rotate the refresh_token on every refresh; callers must
// always persist the value returned in the latest response.

import { generateCodeChallenge, generateCodeVerifier } from "@cognia/provider-core/providers/oauth"

import type { AnthropicAuthMode, AnthropicCredentialData } from "@/types/subscription"
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_TOKEN_URL, OAUTH_ENDPOINTS } from "./constants"

export interface OAuthFlowState {
  state: string
  codeVerifier: string
  mode: AnthropicAuthMode
  redirectUri: string
}

export interface AuthorizeUrlResult {
  url: string
  flowState: OAuthFlowState
}

/**
 * Build the URL the user opens to authorize cognia-next. The `code=true`
 * query parameter forces the manual-code variant (the redirect target
 * displays the code on a page rather than calling back to a localhost
 * loopback we'd have to register).
 */
export async function buildAuthorizeUrl(input: {
  mode: AnthropicAuthMode
}): Promise<AuthorizeUrlResult> {
  const config = OAUTH_ENDPOINTS[input.mode]
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = generateCodeVerifier() // crypto-random; reused for state too.

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    code: "true",
  })

  return {
    url: `${config.authorizeUrl}?${params.toString()}`,
    flowState: {
      state,
      codeVerifier,
      mode: input.mode,
      redirectUri: config.redirectUri,
    },
  }
}

/**
 * Some users paste the entire URL from the redirect page; others paste just
 * the code. Some callback pages also surface the code as `code#state` (the
 * `#` separator is what the Anthropic redirect page uses). Tolerate all of
 * these shapes.
 */
export function extractAuthorizationCode(input: string): { code: string; state?: string } | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const code = url.searchParams.get("code")
      if (!code) return null
      const state = url.searchParams.get("state") ?? undefined
      return { code, state }
    } catch {
      return null
    }
  }

  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#", 2)
    if (!code) return null
    return { code, state }
  }

  return { code: trimmed }
}

interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number // seconds
  scope?: string
  account?: { email?: string; uuid?: string; plan?: string }
}

function buildCredential(
  raw: RawTokenResponse,
  mode: AnthropicAuthMode,
  fallbackRefreshToken?: string
): AnthropicCredentialData {
  if (!raw.access_token) {
    throw new Error("token endpoint returned no access_token")
  }
  const refreshToken = raw.refresh_token ?? fallbackRefreshToken ?? ""
  if (!refreshToken) {
    throw new Error("token endpoint returned no refresh_token")
  }
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : 8 * 3600
  const now = Date.now()
  return {
    accessToken: raw.access_token,
    refreshToken,
    expiresAtMs: now + expiresIn * 1000,
    mode,
    scope: raw.scope,
    email: raw.account?.email,
    plan: raw.account?.plan,
    storedAtMs: now,
  }
}

/**
 * Resolve the OAuth token endpoint. In production this is the upstream
 * `platform.claude.com` URL. Under E2E (`NEXT_PUBLIC_E2E=1`) the renderer
 * may publish a mock base URL via `window.__cogniaMockBaseUrls.anthropic`;
 * when present the token POST is redirected to `${mock}/v1/oauth/token`
 * so specs can drive the flow without hitting the real Anthropic endpoint.
 * Outside the browser (SSR / sidecar) the override is never consulted.
 */
function resolveTokenUrl(): string {
  if (typeof window !== "undefined") {
    const w = window as {
      __cogniaMockBaseUrls?: { anthropic?: string }
    }
    const mock = w.__cogniaMockBaseUrls?.anthropic
    if (mock) return `${mock.replace(/\/$/, "")}/v1/oauth/token`
  }
  return CLAUDE_OAUTH_TOKEN_URL
}

async function postTokenForm(body: URLSearchParams): Promise<RawTokenResponse> {
  // Routed through `proxyFetch` so users behind a corporate firewall or
  // CN network can still reach `platform.claude.com`. In Tauri the call
  // hops through the Rust `proxy_http_request` command; in the browser
  // build the system proxy is honoured automatically.
  const { proxyFetch } = await import("@/lib/network/proxy-fetch")
  const res = await proxyFetch(resolveTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`token endpoint ${res.status}: ${text || res.statusText}`)
  }
  return (await res.json()) as RawTokenResponse
}

export interface ExchangeCodeInput {
  code: string
  flowState: OAuthFlowState
}

export async function exchangeCodeForTokens(
  input: ExchangeCodeInput
): Promise<AnthropicCredentialData> {
  const { code, flowState } = input
  if (!code.trim()) throw new Error("code must not be empty")
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: flowState.redirectUri,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    code_verifier: flowState.codeVerifier,
  })
  const raw = await postTokenForm(body)
  return buildCredential(raw, flowState.mode)
}

export interface RefreshTokenInput {
  refreshToken: string
  mode: AnthropicAuthMode
}

export async function refreshAccessToken(
  input: RefreshTokenInput
): Promise<AnthropicCredentialData> {
  if (!input.refreshToken.trim()) throw new Error("refreshToken must not be empty")
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  })
  const raw = await postTokenForm(body)
  return buildCredential(raw, input.mode, input.refreshToken)
}

/**
 * `true` when an `accessToken` is present *and* the absolute expiry hasn't
 * elapsed. Use this for the "logged in?" badge; kicking off a refresh is the
 * caller's job. The 60-second grace avoids a race where a probe / agent send
 * starts just before the bearer flips stale.
 */
export function isAnthropicCredentialFresh(
  credential: AnthropicCredentialData | null,
  nowMs: number = Date.now(),
  graceMs: number = 60_000
): boolean {
  if (!credential || !credential.accessToken) return false
  return credential.expiresAtMs - graceMs > nowMs
}

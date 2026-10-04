/**
 * Shared helpers for the identity Worker suites (vitest-pool-workers).
 */

import { env } from "cloudflare:test"
import { testUtils } from "better-auth/plugins"

import { createAuth } from "../src/auth"
import { readConfig, type IdentityConfig } from "../src/config"
import type { Env } from "../src/env"
import { handleRequest } from "../src/index"

export const testEnv = env as unknown as Env

export function testConfig(overrides: Partial<Env> = {}): IdentityConfig {
  return readConfig({ ...testEnv, ...overrides })
}

export const ISSUER = "https://id.test/api/auth"
export const SYNC_AUDIENCE = "https://sync.cognia.cn"
export const LOOPBACK_REDIRECT = "http://127.0.0.1:51234/callback"
export const NATIVE_REDIRECT = "cn.cognia.app:/auth/callback"

/** A request to the Worker under test, as a client would send it. */
export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return handleRequest(new Request(new URL(path, "https://id.test"), init), testEnv)
}

/**
 * A signed-in browser session at the issuer, minted through Better Auth's
 * test utilities on the same D1 and secrets the Worker uses.
 */
export async function signedInSession(email = `ada-${crypto.randomUUID()}@example.com`): Promise<{
  userId: string
  cookie: string
}> {
  const auth = createAuth(testConfig(), testEnv.DB, { extraPlugins: [testUtils()] })
  const context = (await auth.$context) as unknown as {
    test: {
      createUser: (input: Record<string, unknown>) => Record<string, unknown> & { id: string }
      saveUser: (user: Record<string, unknown>) => Promise<{ id: string }>
      login: (input: { userId: string }) => Promise<{ headers: Headers }>
    }
  }
  const user = await context.test.saveUser(
    context.test.createUser({ email, name: "Ada", emailVerified: true })
  )
  const { headers } = await context.test.login({ userId: user.id })
  return { userId: user.id, cookie: headers.get("cookie") ?? "" }
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return btoa(String.fromCharCode(...view))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(digest) }
}

export interface AuthorizeInput {
  clientId?: string
  redirectUri?: string
  scope?: string
  cookie?: string
  extra?: Record<string, string>
}

/** The URL an authorize request redirects to (code or error), following JSON redirects too. */
export async function authorize(
  input: AuthorizeInput & { challenge: string; state?: string }
): Promise<URL> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId ?? "cognia-app",
    redirect_uri: input.redirectUri ?? LOOPBACK_REDIRECT,
    scope: input.scope ?? "openid profile offline_access",
    state: input.state ?? "state-1",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    resource: SYNC_AUDIENCE,
    ...input.extra,
  })
  const response = await call(`/api/auth/oauth2/authorize?${params}`, {
    headers: input.cookie ? { cookie: input.cookie } : {},
    redirect: "manual",
  })
  const location =
    response.headers.get("location") ??
    (response.headers.get("content-type")?.includes("json")
      ? ((await response.json()) as { url?: string }).url
      : null)
  if (!location)
    throw new Error(`authorize did not redirect: ${response.status} ${await response.text()}`)
  return new URL(location, "https://id.test")
}

export interface TokenSet {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in: number
  scope: string
  token_type: string
}

export async function exchangeCode(input: {
  code: string
  verifier: string
  clientId?: string
  redirectUri?: string
  origin?: string
}): Promise<Response> {
  return call("/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(input.origin ? { origin: input.origin } : {}),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId ?? "cognia-app",
      code: input.code,
      redirect_uri: input.redirectUri ?? LOOPBACK_REDIRECT,
      code_verifier: input.verifier,
      resource: SYNC_AUDIENCE,
    }),
  })
}

/** Sign in and run the whole public-client flow; returns the token set. */
export async function signInAndGetTokens(
  input: AuthorizeInput = {}
): Promise<{ userId: string; tokens: TokenSet }> {
  const session = input.cookie ? { userId: "", cookie: input.cookie } : await signedInSession()
  const { verifier, challenge } = await pkcePair()
  const callback = await authorize({ ...input, cookie: session.cookie, challenge })
  const code = callback.searchParams.get("code")
  if (!code) throw new Error(`no code: ${callback}`)
  const response = await exchangeCode({
    code,
    verifier,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
  })
  if (!response.ok)
    throw new Error(`token exchange failed: ${response.status} ${await response.text()}`)
  return { userId: session.userId, tokens: (await response.json()) as TokenSet }
}

export function decodeJwt(token: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
} {
  const [header, payload] = token.split(".")
  const decode = (part: string) => {
    const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/"))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  }
  return { header: decode(header!), payload: decode(payload!) }
}

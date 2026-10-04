/**
 * SPIKE (ADR-0215 §2): the official OIDC issuer as Better Auth on Workers + D1.
 *
 * Questions this spike answers:
 *   1. Does Better Auth mint access tokens whose `aud` is the sync API and
 *      whose `sub` (a `usr_` id) `cognia-tenant-auth::oidc` accepts?
 *   2. Does Feishu login work through `genericOAuth` with the v2 token
 *      endpoint, keyed on (tenant_key, union_id) and never open_id?
 *   3. Can a public PKCE client (the Cognia apps) sign in against it the same
 *      way it signs in against self-hosted Logto?
 */

import { betterAuth } from "better-auth"
import { genericOAuth, jwt } from "better-auth/plugins"
import { oauthProvider } from "@better-auth/oauth-provider"

import type { Env } from "./env"

/** ADR-0149 §1: `usr_[A-Za-z0-9][A-Za-z0-9_-]{2,63}`. 32 hex chars of entropy. */
export function newUserId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `usr_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

interface FeishuEnvelope<T> {
  code: number
  msg?: string
  data?: T
}

interface FeishuTokenResponse {
  code: number
  error?: string
  error_description?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
  token_type?: string
}

interface FeishuUserInfo {
  name?: string
  en_name?: string
  avatar_url?: string
  open_id?: string
  union_id?: string
  user_id?: string
  email?: string
  enterprise_email?: string
  tenant_key?: string
}

function feishuProvider(env: Env) {
  return {
    providerId: "feishu",
    name: "Feishu",
    authorizationUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
    userInfoUrl: "https://open.feishu.cn/open-apis/authen/v1/user_info",
    clientId: env.FEISHU_APP_ID ?? "",
    clientSecret: env.FEISHU_APP_SECRET ?? "",
    pkce: true,
    // Basic identity needs no scope; ADR-0215 D9 asks for minimal scopes.
    scopes: [] as string[],
    // The v2 token endpoint takes JSON and wraps errors in `code`, so the
    // default form-encoded exchange is replaced.
    getToken: async (data: { code: string; redirectURI: string; codeVerifier?: string }) => {
      const response = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: env.FEISHU_APP_ID,
          client_secret: env.FEISHU_APP_SECRET,
          code: data.code,
          redirect_uri: data.redirectURI,
          ...(data.codeVerifier ? { code_verifier: data.codeVerifier } : {}),
        }),
      })
      const body = (await response.json()) as FeishuTokenResponse
      if (body.code !== 0 || !body.access_token) {
        throw new Error(
          `feishu token exchange failed: ${body.code} ${body.error ?? ""} ${body.error_description ?? ""}`
        )
      }
      const now = Date.now()
      return {
        tokenType: body.token_type ?? "Bearer",
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        accessTokenExpiresAt: body.expires_in ? new Date(now + body.expires_in * 1000) : undefined,
        refreshTokenExpiresAt: body.refresh_token_expires_in
          ? new Date(now + body.refresh_token_expires_in * 1000)
          : undefined,
        scopes: body.scope ? body.scope.split(" ").filter(Boolean) : [],
        raw: body as unknown as Record<string, unknown>,
      }
    },
    getUserInfo: async (tokens: { accessToken?: string }) => {
      const response = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      const body = (await response.json()) as FeishuEnvelope<FeishuUserInfo>
      const info = body.data
      if (body.code !== 0 || !info?.union_id || !info.tenant_key) return null
      const email = info.enterprise_email || info.email
      return {
        // Keyed on (tenant_key, union_id): open_id is per app and would split
        // one person across our bots (ADR-0215 §2, ADR-0091).
        id: `${info.tenant_key}:${info.union_id}`,
        name: info.name || info.en_name || "Feishu user",
        // Feishu frequently returns no email. Better Auth requires one, so a
        // non-routable placeholder stands in and is never marked verified.
        email: email || `${info.union_id}.${info.tenant_key}@feishu.users.invalid`,
        emailVerified: false,
        image: info.avatar_url,
        tenant_key: info.tenant_key,
        union_id: info.union_id,
      }
    },
    accountSubject: ({ profile }: { profile: Record<string, unknown> }) =>
      `${String(profile.tenant_key)}:${String(profile.union_id)}`,
  }
}

const PROVIDER_TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
] as const

/** Strip provider tokens from social accounts; the credential account keeps its password hash. */
export function withoutProviderTokens<T extends Record<string, unknown>>(account: T): T {
  if (account.providerId === "credential") return account
  const stripped: Record<string, unknown> = { ...account }
  for (const field of PROVIDER_TOKEN_FIELDS) {
    if (field in stripped) stripped[field] = null
  }
  return stripped as T
}

export function createAuth(env: Env) {
  const feishuConfigured = Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET)
  return betterAuth({
    baseURL: env.BASE_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    // Spike-only: lets the headless verification script sign in without a
    // browser. The official issuer offers social login; email is optional.
    emailAndPassword: { enabled: true },
    // The JWT plugin's own /token mints session JWTs for this site; Cognia
    // clients must go through the OAuth flow instead.
    disabledPaths: ["/token"],
    trustedOrigins: [env.BASE_URL],
    // ADR-0215 §2, §9: login identity is not Feishu user authorization. The
    // issuer only needs the provider to vouch for (tenant_key, union_id) once;
    // keeping the provider's access/refresh tokens would make the issuer a
    // store of Feishu credentials it never uses. Better Auth has no switch for
    // this, so they are dropped before every account write.
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
        update: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
      },
    },
    advanced: {
      database: {
        generateId: ({ model }) => (model === "user" ? newUserId() : crypto.randomUUID()),
      },
    },
    plugins: [
      jwt({
        jwks: {
          // P-256, the curve ADR-0215 standardizes on. Rotation is explicit.
          keyPairConfig: { alg: "ES256" },
          rotationInterval: 60 * 60 * 24 * 30,
          gracePeriod: 60 * 60 * 24 * 7,
        },
      }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: ["openid", "profile", "email", "offline_access", "sync"],
        // Config is the source of truth for resources; the default
        // `insertOnly` would silently keep a stale row after a config change.
        resourceSeedMode: "overwrite",
        resources: [
          {
            identifier: env.SYNC_AUDIENCE,
            allowedScopes: ["openid", "profile", "email", "offline_access", "sync"],
            accessTokenTtl: 900,
          },
        ],
      }),
      ...(feishuConfigured ? [genericOAuth({ config: [feishuProvider(env)] })] : []),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

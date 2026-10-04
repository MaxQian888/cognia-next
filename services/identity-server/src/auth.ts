/**
 * The official Cognia account: a Better Auth OIDC issuer (ADR-0215 §2).
 *
 * - `iss` is `${BASE_URL}/api/auth`; discovery lives under it.
 * - Access tokens for the sync API (`resource` = `SYNC_AUDIENCE`) are ES256
 *   `at+jwt` with a `kid`, which `cognia-tenant-auth::oidc` verifies; `sub` is
 *   the person's `usr_` id (ADR-0149 §1).
 * - The only clients are the two first-party public clients seeded by
 *   migration (`first-party-clients.ts`); every client and resource management
 *   path is closed (`clientPrivileges` / `resourcePrivileges`, plus the route
 *   allowlist in `route-allowlist.ts`).
 * - Sign-in is social only. Provider tokens are dropped before they are
 *   written: the issuer keeps who the person is, never access to their
 *   provider account.
 */

import { betterAuth, type BetterAuthOptions } from "better-auth"
import { jwt } from "better-auth/plugins"
import { oauthProvider } from "@better-auth/oauth-provider"

import { AUTH_BASE_PATH, type IdentityConfig } from "./config"
import { FIRST_PARTY_CLIENT_IDS } from "./first-party-clients"
import { IDENTITIES_CLAIM, identitiesClaimExtension } from "./identities-claim"
import { providerSetup } from "./providers"

/** ADR-0149 §1: `usr_[A-Za-z0-9][A-Za-z0-9_-]{2,63}`. 32 hex chars of entropy. */
export function newUserId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `usr_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

/** Scopes the issuer understands. The sync API needs no scope of its own: its audience is the grant. */
export const SUPPORTED_SCOPES = ["openid", "profile", "email", "offline_access"] as const

/** Every claim a token or UserInfo response may carry; `claims_supported` is not inferred. */
export const SUPPORTED_CLAIMS = [
  "sub",
  "iss",
  "aud",
  "exp",
  "iat",
  "auth_time",
  "sid",
  "scope",
  "azp",
  "client_id",
  "name",
  "picture",
  "email",
  "email_verified",
  IDENTITIES_CLAIM,
] as const

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Better Auth endpoints the HTTP surface never offers. The allowlist in
 * `route-allowlist.ts` is the real gate; this is the library-level backstop
 * for exact paths.
 */
export const DISABLED_PATHS = [
  // The jwt plugin's session-to-JWT endpoint: Cognia clients use OAuth.
  "/token",
  "/sign-up/email",
  "/sign-in/email",
  "/delete-user",
  "/delete-user/callback",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/update-user",
  "/change-email",
  "/oauth2/register",
  "/oauth2/create-client",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/get-clients",
  "/oauth2/client/rotate-secret",
]

const PROVIDER_TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
] as const

/**
 * Strip provider tokens from social accounts before they are written
 * (ADR-0215 §2, §9). Better Auth has no switch for this.
 */
export function withoutProviderTokens<T extends Record<string, unknown>>(account: T): T {
  if (account.providerId === "credential") return account
  const stripped: Record<string, unknown> = { ...account }
  for (const field of PROVIDER_TOKEN_FIELDS) {
    if (field in stripped) stripped[field] = null
  }
  return stripped as T
}

/** Reserved-domain placeholders (the Feishu case) are not emails to publish. */
export function isPlaceholderEmail(email: unknown): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(".invalid")
}

export interface CreateAuthOptions {
  /** Required when Sign in with Apple is configured (`providers/apple-secret.ts`). */
  appleClientSecret?: string
  /** `ctx.waitUntil`, so Better Auth's background work outlives the response. */
  waitUntil?: (promise: Promise<unknown>) => void
  fetchImpl?: typeof fetch
  /** Test seam: extra plugins (e.g. `testUtils()`), never set in production. */
  extraPlugins?: BetterAuthOptions["plugins"]
}

export function authOptions(
  config: IdentityConfig,
  db: D1Database,
  options: CreateAuthOptions = {}
) {
  const providers = providerSetup(config, {
    ...(options.appleClientSecret ? { appleClientSecret: options.appleClientSecret } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const waitUntil = options.waitUntil
  return {
    appName: "Cognia",
    baseURL: config.baseUrl,
    basePath: AUTH_BASE_PATH,
    secrets: config.secrets,
    database: db,
    emailAndPassword: { enabled: false },
    socialProviders: providers.socialProviders,
    disabledPaths: DISABLED_PATHS,
    // Apple returns with a cross-site form POST.
    trustedOrigins: [config.baseUrl, "https://appleid.apple.com"],
    account: {
      // Two sign-ins are one person only when both providers verified the
      // same email; Feishu never vouches for an email (providers/feishu.ts).
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    },
    user: {
      deleteUser: { enabled: false },
      changeEmail: { enabled: false },
    },
    rateLimit: {
      // Off by default outside NODE_ENV=production, and per-isolate memory is
      // useless on Workers: count in D1.
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/social": { window: 60, max: 10 },
        "/callback/*": { window: 60, max: 20 },
      },
    },
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
        update: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
      },
    },
    onAPIError: { errorURL: `${config.baseUrl}/error` },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: {
        generateId: ({ model }) => (model === "user" ? newUserId() : crypto.randomUUID()),
      },
      ...(waitUntil
        ? { backgroundTasks: { handler: (promise: Promise<unknown>) => waitUntil(promise) } }
        : {}),
    },
    plugins: [
      jwt({
        jwks: {
          // P-256, the curve ADR-0215 standardizes on. Keys rotate lazily on
          // the first signature after `rotationInterval`; the old key stays
          // in the JWKS for `gracePeriod`, longer than any token it signed.
          keyPairConfig: { alg: "ES256" },
          rotationInterval: 30 * 24 * 60 * 60,
          gracePeriod: 7 * 24 * 60 * 60,
        },
      }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: [...SUPPORTED_SCOPES],
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
        resources: [
          {
            identifier: config.syncAudience,
            name: "Cognia sync",
            allowedScopes: [...SUPPORTED_SCOPES],
            accessTokenTtl: ACCESS_TOKEN_TTL_SECONDS,
          },
        ],
        // Configuration is the source of truth for resources; the default
        // `insertOnly` would keep a stale row after a config change.
        resourceSeedMode: "overwrite",
        enforcePerClientResources: true,
        cachedTrustedClients: new Set(FIRST_PARTY_CLIENT_IDS),
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
        advertisedMetadata: {
          scopes_supported: [...SUPPORTED_SCOPES],
          claims_supported: [...SUPPORTED_CLAIMS],
        },
        // The OIDC profile claims are not in Better Auth's ID token; the
        // apps read the person's name from it.
        customIdTokenClaims: ({ user, scopes }) => {
          const claims: Record<string, unknown> = {}
          if (scopes.includes("profile")) {
            if (user.name) claims.name = user.name
            if (user.image) claims.picture = user.image
          }
          if (scopes.includes("email") && user.email && !isPlaceholderEmail(user.email)) {
            claims.email = user.email
            claims.email_verified = Boolean(user.emailVerified)
          }
          return claims
        },
        extensions: [identitiesClaimExtension],
      }),
      ...providers.plugins,
      ...(options.extraPlugins ?? []),
    ],
  } satisfies BetterAuthOptions
}

export function createAuth(
  config: IdentityConfig,
  db: D1Database,
  options: CreateAuthOptions = {}
) {
  return betterAuth(authOptions(config, db, options))
}

export type Auth = ReturnType<typeof createAuth>

/**
 * The Worker's configuration, parsed once from its bindings.
 *
 * Every value that shapes a security decision is validated here so a typo in
 * wrangler.toml or a secret fails the request loudly instead of silently
 * issuing tokens with the wrong issuer, trusting a stray origin, or offering a
 * provider whose credentials are half set.
 */

import type { Env } from "./env"

export type ProviderId = "feishu" | "github" | "google" | "apple"

/** The order the sign-in page offers providers in. */
export const PROVIDER_ORDER: readonly ProviderId[] = ["feishu", "github", "google", "apple"]

export interface FeishuCredentials {
  appId: string
  appSecret: string
}

export interface OAuthCredentials {
  clientId: string
  clientSecret: string
}

export interface AppleCredentials {
  /** The Services ID registered for Sign in with Apple on the web. */
  serviceId: string
  teamId: string
  keyId: string
  /** The `.p8` private key, PEM (PKCS#8). */
  privateKey: string
  /** The iOS app's bundle id, accepted as an ID-token audience for native sign-in. */
  appBundleId?: string
}

export interface ProviderCredentials {
  feishu?: FeishuCredentials
  github?: OAuthCredentials
  google?: OAuthCredentials
  apple?: AppleCredentials
}

export interface VersionedSecret {
  version: number
  value: string
}

export interface IdentityConfig {
  serviceEnv: string
  /** Origin of the Worker, without a trailing slash. */
  baseUrl: string
  /** `${baseUrl}/api/auth`: the `iss` of every token. */
  issuer: string
  syncAudience: string
  /** Exact origins of the official web app, normalised. */
  webOrigins: string[]
  coolingOffDays: number
  /** Newest first; the first one encrypts and signs. */
  secrets: VersionedSecret[]
  providers: ProviderCredentials
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

export const AUTH_BASE_PATH = "/api/auth"

/** Better Auth refuses shorter secrets in production; so do we, everywhere. */
const MIN_SECRET_LENGTH = 32

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * An origin and nothing else. Plain http is accepted only for a loopback host
 * and never in production.
 */
export function parseOrigin(raw: string, serviceEnv: string, what: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`${what} is not a URL: ${JSON.stringify(raw)}`)
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(`${what} must be an origin without a path: ${JSON.stringify(raw)}`)
  }
  if (url.protocol === "https:") return url.origin
  if (url.protocol === "http:" && isLoopbackHost(url.hostname) && serviceEnv !== "production") {
    return url.origin
  }
  throw new ConfigError(`${what} must use https: ${JSON.stringify(raw)}`)
}

/** `"2:<value>,1:<value>"`, newest first, each version unique and positive. */
export function parseSecrets(raw: string | undefined): VersionedSecret[] {
  const value = nonEmpty(raw)
  if (!value) throw new ConfigError("BETTER_AUTH_SECRETS is not set")
  const secrets: VersionedSecret[] = []
  const seen = new Set<number>()
  for (const entry of value.split(",")) {
    const trimmed = entry.trim()
    const separator = trimmed.indexOf(":")
    const version = Number(trimmed.slice(0, separator))
    const secret = trimmed.slice(separator + 1)
    if (separator <= 0 || !Number.isInteger(version) || version <= 0) {
      throw new ConfigError("BETTER_AUTH_SECRETS entries must read <version>:<secret>")
    }
    if (seen.has(version)) throw new ConfigError(`BETTER_AUTH_SECRETS repeats version ${version}`)
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new ConfigError(
        `BETTER_AUTH_SECRETS version ${version} is shorter than ${MIN_SECRET_LENGTH} characters`
      )
    }
    seen.add(version)
    secrets.push({ version, value: secret })
  }
  return secrets
}

/**
 * Credentials for one provider: all of them, or none. A half-configured
 * provider is an operator mistake, not a reason to show a broken button.
 */
function allOrNothing<T extends Record<string, string | undefined>>(
  name: string,
  fields: T
): { [K in keyof T]: string } | undefined {
  const present = Object.entries(fields).filter(([, value]) => nonEmpty(value) !== undefined)
  if (present.length === 0) return undefined
  if (present.length !== Object.keys(fields).length) {
    const missing = Object.entries(fields)
      .filter(([, value]) => nonEmpty(value) === undefined)
      .map(([key]) => key)
    throw new ConfigError(`${name} is partially configured; missing ${missing.join(", ")}`)
  }
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, (value as string).trim()])
  ) as { [K in keyof T]: string }
}

export function readProviders(env: Env): ProviderCredentials {
  const providers: ProviderCredentials = {}
  const feishu = allOrNothing("Feishu", {
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
  })
  if (feishu) providers.feishu = feishu
  const github = allOrNothing("GitHub", {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  })
  if (github) providers.github = github
  const google = allOrNothing("Google", {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  })
  if (google) providers.google = google
  const apple = allOrNothing("Apple", {
    serviceId: env.APPLE_SERVICE_ID,
    teamId: env.APPLE_TEAM_ID,
    keyId: env.APPLE_KEY_ID,
    privateKey: env.APPLE_PRIVATE_KEY,
  })
  if (apple) {
    const appBundleId = nonEmpty(env.APPLE_APP_BUNDLE_ID)
    providers.apple = { ...apple, ...(appBundleId ? { appBundleId } : {}) }
  } else if (nonEmpty(env.APPLE_APP_BUNDLE_ID)) {
    throw new ConfigError("APPLE_APP_BUNDLE_ID is set but Sign in with Apple is not configured")
  }
  return providers
}

export function enabledProviders(config: Pick<IdentityConfig, "providers">): ProviderId[] {
  return PROVIDER_ORDER.filter((id) => config.providers[id] !== undefined)
}

export function readConfig(env: Env): IdentityConfig {
  const serviceEnv = nonEmpty(env.SERVICE_ENV) ?? "production"
  const baseUrl = parseOrigin(env.BASE_URL ?? "", serviceEnv, "BASE_URL")
  const syncAudience = nonEmpty(env.SYNC_AUDIENCE)
  if (!syncAudience) throw new ConfigError("SYNC_AUDIENCE is not set")
  try {
    new URL(syncAudience)
  } catch {
    throw new ConfigError(`SYNC_AUDIENCE is not a URL: ${JSON.stringify(syncAudience)}`)
  }
  const webOrigins = [
    ...new Set(
      (env.WEB_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
        .map((origin) => parseOrigin(origin, serviceEnv, "WEB_ORIGINS"))
    ),
  ]
  const coolingOffRaw = nonEmpty(env.ACCOUNT_DELETION_COOLING_OFF_DAYS) ?? "7"
  const coolingOffDays = Number(coolingOffRaw)
  if (!Number.isInteger(coolingOffDays) || coolingOffDays < 1) {
    throw new ConfigError(
      "ACCOUNT_DELETION_COOLING_OFF_DAYS must be a whole number of days, at least 1"
    )
  }
  return {
    serviceEnv,
    baseUrl,
    issuer: `${baseUrl}${AUTH_BASE_PATH}`,
    syncAudience,
    webOrigins,
    coolingOffDays,
    secrets: parseSecrets(env.BETTER_AUTH_SECRETS),
    providers: readProviders(env),
  }
}

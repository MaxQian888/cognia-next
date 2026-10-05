/**
 * The official Cognia account, the deployment every build knows without
 * being told (ADR-0215 §2).
 *
 * A self-hosted deployment announces its issuer through
 * `GET /api/auth/config` (`deployment-discovery.ts`). The official account is
 * the default when nothing announces anything: its issuer, audience and the
 * two first-party clients are fixed here, so a fresh install can sign in
 * before it has paired with, or been pointed at, any host.
 *
 * # Overrides
 *
 * - `NEXT_PUBLIC_COGNIA_ID_ISSUER` / `NEXT_PUBLIC_COGNIA_ID_AUDIENCE` point a
 *   build at staging or at a developer's local identity Worker.
 * - `NEXT_PUBLIC_COGNIA_SYNC_URL` points account sync at another sync Worker
 *   (staging's is `https://sync-staging.cognia.cn`; the audience stays
 *   `https://sync.cognia.cn`, since `iss` tells environments apart).
 * - `NEXT_PUBLIC_COGNIA_OFFICIAL_ACCOUNT=0` switches the official account off
 *   entirely. The self-hosted web image is built that way: its people sign in
 *   to their own deployment or not at all.
 *
 * The desktop host trusts the same issuer on its own authority
 * (`crates/cognia-companion-security/src/official_identity.rs`); a renderer
 * override does not change what the host will verify.
 */

import type { LogtoClientConfig } from "@/lib/logto/client"

export const OFFICIAL_ISSUER_DEFAULT = "https://id.cognia.cn/api/auth"
export const OFFICIAL_AUDIENCE_DEFAULT = "https://sync.cognia.cn"
/** The account sync Worker (ADR-0215 phase 2, `services/sync-server`). */
export const OFFICIAL_SYNC_URL_DEFAULT = "https://sync.cognia.cn"
/** Desktop, phone and CLI: a public PKCE client with native redirects. */
export const OFFICIAL_NATIVE_CLIENT_ID = "cognia-app"
/** The official web app: a public PKCE client on the web origins. */
export const OFFICIAL_WEB_CLIENT_ID = "cognia-web"
/** Beyond the `openid` / `offline_access` every sign-in asks for. */
export const OFFICIAL_SCOPES = ["profile", "email"] as const

/** The sign-in methods the official issuer offers, in screen order. */
export const OFFICIAL_SOCIAL_PROVIDERS = ["feishu", "github", "google", "apple"] as const
export type OfficialSocialProvider = (typeof OFFICIAL_SOCIAL_PROVIDERS)[number]

export interface OfficialDeployment {
  kind: "official"
  issuer: string
  audience: string
  nativeClientId: string
  webClientId: string
  issuerKind: "oidc"
  social: readonly OfficialSocialProvider[]
}

export interface OfficialDeploymentEnv {
  enabled?: string
  issuer?: string
  audience?: string
}

/**
 * The build's own values. Each `process.env.NEXT_PUBLIC_*` is read literally
 * because Next inlines only literal reads into the static export.
 */
function buildEnv(): OfficialDeploymentEnv {
  return {
    enabled: process.env.NEXT_PUBLIC_COGNIA_OFFICIAL_ACCOUNT,
    issuer: process.env.NEXT_PUBLIC_COGNIA_ID_ISSUER,
    audience: process.env.NEXT_PUBLIC_COGNIA_ID_AUDIENCE,
  }
}

function trimmedUrl(raw: string | undefined, fallback: string): string {
  const value = raw?.trim().replace(/\/+$/, "")
  if (!value) return fallback
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? value : fallback
  } catch {
    return fallback
  }
}

/** Whether this build offers the official account at all. */
export function officialAccountEnabled(env: OfficialDeploymentEnv = buildEnv()): boolean {
  const flag = env.enabled?.trim().toLowerCase()
  return flag !== "0" && flag !== "false" && flag !== "off"
}

/** The official deployment, or `null` when this build switched it off. */
export function officialDeployment(
  env: OfficialDeploymentEnv = buildEnv()
): OfficialDeployment | null {
  if (!officialAccountEnabled(env)) return null
  return {
    kind: "official",
    issuer: trimmedUrl(env.issuer, OFFICIAL_ISSUER_DEFAULT),
    audience: trimmedUrl(env.audience, OFFICIAL_AUDIENCE_DEFAULT),
    nativeClientId: OFFICIAL_NATIVE_CLIENT_ID,
    webClientId: OFFICIAL_WEB_CLIENT_ID,
    issuerKind: "oidc",
    social: OFFICIAL_SOCIAL_PROVIDERS,
  }
}

/** Where account sync talks to: the build's override, or the official sync Worker. */
export function officialSyncUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_COGNIA_SYNC_URL
): string {
  return trimmedUrl(raw, OFFICIAL_SYNC_URL_DEFAULT)
}

export function isOfficialSocialProvider(value: string): value is OfficialSocialProvider {
  return (OFFICIAL_SOCIAL_PROVIDERS as readonly string[]).includes(value)
}

/** Whether a session's issuer is the official one this build knows. */
export function isOfficialIssuer(
  issuer: string,
  deployment: OfficialDeployment | null = officialDeployment()
): boolean {
  return !!deployment && issuer.replace(/\/+$/, "") === deployment.issuer
}

export interface OfficialConfigOptions {
  redirectUri: string
  /** Web popups use `cognia-web`; desktop, phone and CLI use `cognia-app`. */
  clientKind: "web" | "native"
  /** Skip the official sign-in page and go straight to this provider. */
  socialProvider?: OfficialSocialProvider
  /** Force a new authentication (`prompt=login&max_age=0`), e.g. before deletion. */
  freshLogin?: boolean
}

/** The client configuration for signing in to the official account. */
export function officialLogtoConfig(
  deployment: OfficialDeployment,
  options: OfficialConfigOptions
): LogtoClientConfig {
  return {
    issuer: deployment.issuer,
    clientId: options.clientKind === "native" ? deployment.nativeClientId : deployment.webClientId,
    redirectUri: options.redirectUri,
    resource: deployment.audience,
    scopes: [...OFFICIAL_SCOPES],
    issuerKind: deployment.issuerKind,
    ...(options.socialProvider ? { socialProvider: options.socialProvider } : {}),
    ...(options.freshLogin ? { freshLogin: true } : {}),
  }
}

/**
 * Which deployment this profile can sign in to, and what it offers.
 *
 * # Where the answer comes from
 *
 * `GET /api/auth/config` is served by the companion host, and which host that
 * is depends on the shape this client runs in (`detectHostProfile`):
 *
 * - desktop: its own companion server, on the loopback port it is bound to.
 *   A stopped server means there is nothing to discover, not an error.
 * - cloud companion / mobile companion: the paired host, whose base URL and
 *   TLS fingerprint the companion config already holds.
 * - web standalone: the build-time server URL, if the bundle was built with
 *   one. Otherwise there is no deployment, and sign-in is a manual affair.
 * - headless: never asks. It is the host.
 *
 * # What "none" means
 *
 * A single-user deployment, or no host at all, is the ordinary case for most
 * installs and is reported as `none` with the reason, so the gate can let the
 * person straight through instead of treating an absent server as a fault.
 */

import {
  authConfigCollaborationServiceUrl,
  authConfigSocialProviders,
  fetchCompanionAuthConfig,
  type CompanionAuthConfig,
} from "@/lib/tauri/companion-auth"
import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"
import { buildTimeServerUrl } from "@/lib/platform/web-companion"
import { loadCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"

export type SocialProvider = ReturnType<typeof authConfigSocialProviders>[number]

export type DeploymentDiscovery =
  | { status: "none"; reason: "no-host" | "single-user" | "server-stopped" }
  | {
      status: "unavailable"
      reason: "unreachable" | "malformed"
      baseUrl: string
      message: string
    }
  | {
      status: "ready"
      baseUrl: string
      fingerprint?: string
      config: CompanionAuthConfig
      social: SocialProvider[]
      collaborationServiceUrl: string | null
      registrationPolicy: string | null
    }

export type ReadyDeployment = Extract<DeploymentDiscovery, { status: "ready" }>

export interface DiscoverySource {
  baseUrl: string
  fingerprint?: string
}

export interface DiscoverDeploymentDeps {
  profile?: HostProfile
  companionConfig?: () => CompanionConfig | null
  /** The desktop's own companion server. Defaults to the Tauri command. */
  serverStatus?: () => Promise<{ running: boolean; boundPort?: number | null }>
  buildTimeUrl?: () => string | null
  fetchConfig?: (baseUrl: string, fingerprint?: string) => Promise<CompanionAuthConfig>
}

async function desktopServerStatus(): Promise<{ running: boolean; boundPort?: number | null }> {
  // Lazy so this module stays a leaf for the node test project and for the
  // web bundle, where the Tauri transport is never constructed.
  const { transport } = await import("@/lib/tauri")
  return transport.call<{ running: boolean; boundPort?: number | null }>(
    "companion_server_status",
    {}
  )
}

/** The host to ask, or the reason there is none. Pure per profile. */
export async function resolveDiscoverySource(
  deps: DiscoverDeploymentDeps = {}
): Promise<DiscoverySource | { none: "no-host" | "server-stopped" }> {
  const profile = deps.profile ?? detectHostProfile()
  switch (profile) {
    case "headless":
      return { none: "no-host" }
    case "desktop": {
      const status = await (deps.serverStatus ?? desktopServerStatus)()
      if (!status.running || !status.boundPort) return { none: "server-stopped" }
      return { baseUrl: `http://127.0.0.1:${status.boundPort}` }
    }
    case "cloud-companion":
    case "mobile-companion": {
      const config = (deps.companionConfig ?? loadCompanionConfig)()
      if (config?.baseUrl) {
        return config.serverFingerprint
          ? { baseUrl: config.baseUrl, fingerprint: config.serverFingerprint }
          : { baseUrl: config.baseUrl }
      }
      const built = (deps.buildTimeUrl ?? buildTimeServerUrl)()
      return built ? { baseUrl: built } : { none: "no-host" }
    }
    case "web-standalone": {
      const built = (deps.buildTimeUrl ?? buildTimeServerUrl)()
      return built ? { baseUrl: built } : { none: "no-host" }
    }
  }
}

/** Ask the host what it offers. Never throws: every failure is a state. */
export async function discoverDeployment(
  deps: DiscoverDeploymentDeps = {}
): Promise<DeploymentDiscovery> {
  const source = await resolveDiscoverySource(deps)
  if ("none" in source) return { status: "none", reason: source.none }
  const fetchConfig =
    deps.fetchConfig ??
    ((baseUrl: string, fingerprint?: string) => fetchCompanionAuthConfig(baseUrl, fingerprint))
  let config: CompanionAuthConfig
  try {
    config = await fetchConfig(source.baseUrl, source.fingerprint)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: "unavailable",
      reason: /malformed|unexpected|invalid|parse/i.test(message) ? "malformed" : "unreachable",
      baseUrl: source.baseUrl,
      message,
    }
  }
  if (config.deploymentMode !== "multi-tenant" || !config.oidc) {
    return { status: "none", reason: "single-user" }
  }
  return {
    status: "ready",
    baseUrl: source.baseUrl,
    ...(source.fingerprint ? { fingerprint: source.fingerprint } : {}),
    config,
    social: authConfigSocialProviders(config),
    collaborationServiceUrl: authConfigCollaborationServiceUrl(config),
    registrationPolicy: config.collaboration?.registrationPolicy ?? null,
  }
}

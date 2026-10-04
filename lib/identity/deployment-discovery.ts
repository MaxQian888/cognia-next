/**
 * Which deployment this profile can sign in to, and what it offers.
 *
 * # Where the answer comes from
 *
 * `GET /api/auth/config` is served by the companion host. A deployment the
 * profile chose (`deployment-source.ts`) is asked first on every shell but
 * headless: it is the only way a desktop or a phone can name a cloud
 * deployment before it has paired with anything. Without one, which host to
 * ask depends on the shape this client runs in (`detectHostProfile`):
 *
 * - desktop: its own companion server, on the loopback port it is bound to,
 *   and the build-time server URL when that server is stopped. A stopped
 *   server with no build-time URL means there is nothing to discover.
 * - cloud companion / mobile companion: the paired host, whose base URL and
 *   TLS fingerprint the companion config already holds.
 * - web standalone: the build-time server URL, if the bundle was built with
 *   one, else its own origin when the bundle was built for a same-origin
 *   front door (`NEXT_PUBLIC_COGNIA_SAME_ORIGIN_HOST=1`, the compose web
 *   image, where Caddy proxies `/api/*` to the gateway). Otherwise there is
 *   no deployment, and sign-in is a manual affair.
 * - headless: never asks. It is the host.
 *
 * # What "none" means
 *
 * A single-user deployment, or no host at all, is the ordinary case for most
 * installs and is reported as `none` with the reason, so the gate can let the
 * person straight through instead of treating an absent server as a fault.
 *
 * # A paired Host this build can only reach over the relay
 *
 * A LAN Host presents a self-signed certificate that the pairing pinned by
 * SPKI. A native HTTP stack that cannot attest pin enforcement refuses the
 * direct request before it leaves the device (`native_spki_pinning_unavailable`),
 * and every companion RPC goes over the relay data lane instead, which the
 * pairing's room keys authenticate end to end (ADR-0170). `/api/auth/config`
 * is plain HTTP with no relay equivalent, so asking it directly can never
 * succeed on such a build. That used to surface as `unavailable`, a full-screen
 * "cannot sign in" in front of a phone whose Host link worked.
 *
 * When the paired Host (not a deployment the profile chose) is that Host and
 * the pairing carries a relay room, this reports `none` / `host-link-only`:
 * there is nothing this device can ask, and the link it does have is the
 * device-key-authenticated one, which needs no cloud session. A pairing with
 * no relay room has no route to the Host at all, and stays `unavailable`.
 */

import {
  authConfigCollaborationServiceUrl,
  authConfigSocialProviders,
  authConfigWebOrigin,
  fetchCompanionAuthConfig,
  type CompanionAuthConfig,
} from "@/lib/tauri/companion-auth"
import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"
import { buildTimeServerUrl } from "@/lib/platform/web-companion"
import { NATIVE_SPKI_PINNING_UNAVAILABLE } from "@/lib/tauri/pinned-fetch"
import { loadCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"
import { loadDeploymentSource, type DeploymentSource } from "./deployment-source"

export type SocialProvider = ReturnType<typeof authConfigSocialProviders>[number]

/**
 * Connector targets the sign-in screen has a label for. Logto's official
 * Feishu connector is `@logto/connector-feishu-web` and its target is
 * `feishu-web`, which the screen used to print as a bare string. Anything
 * else still renders under its target name, so a new connector is never
 * hidden, only unlabelled.
 */
export const KNOWN_SOCIAL_PROVIDERS: ReadonlySet<string> = new Set([
  "github",
  "feishu",
  "feishu-web",
  "lark",
  "google",
  "microsoft",
  "wechat",
])

export type DeploymentDiscovery =
  | {
      status: "none"
      /**
       * `host-link-only`: the paired Host can only be reached over the relay
       * data lane, which carries RPCs but not its plain-HTTP auth config (see
       * the module docs). The gate passes; nothing about the Host link changes.
       */
      reason: "no-host" | "single-user" | "server-stopped" | "host-link-only"
    }
  | {
      status: "unavailable"
      reason: "unreachable" | "malformed"
      baseUrl: string | null
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
      /** Where the web app lives, for links that must open on another machine. */
      webOrigin: string | null
    }

export type ReadyDeployment = Extract<DeploymentDiscovery, { status: "ready" }>

export interface DiscoverySource {
  baseUrl: string
  fingerprint?: string
}

export interface DiscoverDeploymentDeps {
  profile?: HostProfile
  /** Whose stored deployment to read. Defaults to the install-level record. */
  localAccountId?: string | null
  /** The deployment the profile chose. Defaults to the stored record. */
  deploymentSource?: () => DeploymentSource | null
  /** This page's own origin, asked on a same-origin web build. */
  sameOrigin?: () => string | null
  companionConfig?: () => CompanionConfig | null
  /** The desktop's own companion server. Defaults to the Tauri command. */
  serverStatus?: () => Promise<{ running: boolean; boundPort?: number | null }>
  buildTimeUrl?: () => string | null
  fetchConfig?: (baseUrl: string, fingerprint?: string) => Promise<CompanionAuthConfig>
}

async function desktopServerStatus(): Promise<{ running: boolean; boundPort?: number | null }> {
  // Lazy so this module stays a leaf for the node test project and for the
  // web bundle, where the Tauri transport is never constructed.
  const { localTransport: transport } = await import("@/lib/tauri")
  return transport.call<{ running: boolean; boundPort?: number | null }>(
    "companion_server_status",
    {}
  )
}

function sameOriginHost(): string | null {
  if (process.env.NEXT_PUBLIC_COGNIA_SAME_ORIGIN_HOST !== "1") return null
  if (typeof window === "undefined") return null
  const origin = window.location.origin
  return /^https?:\/\//.test(origin) ? origin : null
}

/** The host to ask, or the reason there is none. Pure per profile. */
export async function resolveDiscoverySource(
  deps: DiscoverDeploymentDeps = {}
): Promise<DiscoverySource | { none: "no-host" | "server-stopped" }> {
  const resolved = await resolveSourceWithOrigin(deps)
  return "none" in resolved ? resolved : resolved.source
}

/**
 * {@link resolveDiscoverySource}, plus the pairing the source was read from
 * when it is the paired Host rather than a deployment the profile chose.
 */
async function resolveSourceWithOrigin(
  deps: DiscoverDeploymentDeps
): Promise<
  | { source: DiscoverySource; pairing: CompanionConfig | null }
  | { none: "no-host" | "server-stopped" }
> {
  const profile = deps.profile ?? detectHostProfile()
  if (profile === "headless") return { none: "no-host" }
  const chosen = (
    deps.deploymentSource ?? (() => loadDeploymentSource(deps.localAccountId ?? null))
  )()
  if (chosen) {
    return {
      source: chosen.fingerprint
        ? { baseUrl: chosen.baseUrl, fingerprint: chosen.fingerprint }
        : { baseUrl: chosen.baseUrl },
      pairing: null,
    }
  }
  switch (profile) {
    case "desktop": {
      const status = await (deps.serverStatus ?? desktopServerStatus)()
      if (status.running && status.boundPort) {
        return { source: { baseUrl: `http://127.0.0.1:${status.boundPort}` }, pairing: null }
      }
      const built = (deps.buildTimeUrl ?? buildTimeServerUrl)()
      return built ? { source: { baseUrl: built }, pairing: null } : { none: "server-stopped" }
    }
    case "cloud-companion":
    case "mobile-companion": {
      const config = (deps.companionConfig ?? loadCompanionConfig)()
      if (config?.baseUrl) {
        return {
          source: config.serverFingerprint
            ? { baseUrl: config.baseUrl, fingerprint: config.serverFingerprint }
            : { baseUrl: config.baseUrl },
          pairing: config,
        }
      }
      const built = (deps.buildTimeUrl ?? buildTimeServerUrl)()
      return built ? { source: { baseUrl: built }, pairing: null } : { none: "no-host" }
    }
    case "web-standalone": {
      const built = (deps.buildTimeUrl ?? buildTimeServerUrl)()
      if (built) return { source: { baseUrl: built }, pairing: null }
      const own = (deps.sameOrigin ?? sameOriginHost)()
      return own ? { source: { baseUrl: own }, pairing: null } : { none: "no-host" }
    }
  }
}

/**
 * Whether a pairing has the relay room the companion transport falls back to
 * when the direct pinned route is refused — the same three facts
 * `CompanionTransport.awaitRelayRoute` requires, with the private key in either
 * the runtime or the persisted form.
 */
function pairingHasRelayRoom(pairing: CompanionConfig): boolean {
  return Boolean(
    pairing.rendezvousId &&
    pairing.signalingRoomDescriptor &&
    (pairing.signalingPrivateKey || pairing.signalingPrivateKeyJwk)
  )
}

function isPinningUnavailable(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === NATIVE_SPKI_PINNING_UNAVAILABLE
  )
}

/** Ask the host what it offers. Never throws: every failure is a state. */
export async function discoverDeployment(
  deps: DiscoverDeploymentDeps = {}
): Promise<DeploymentDiscovery> {
  let source: DiscoverySource | undefined
  try {
    const resolved = await resolveSourceWithOrigin(deps)
    if ("none" in resolved) return { status: "none", reason: resolved.none }
    source = resolved.source
    const { pairing } = resolved
    const fetchConfig = deps.fetchConfig ?? fetchCompanionAuthConfig
    let config: CompanionAuthConfig
    try {
      config = await fetchConfig(source.baseUrl, source.fingerprint)
    } catch (error) {
      // See "A paired Host this build can only reach over the relay" above.
      if (pairing && isPinningUnavailable(error) && pairingHasRelayRoom(pairing)) {
        return { status: "none", reason: "host-link-only" }
      }
      throw error
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
      webOrigin: authConfigWebOrigin(config),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: "unavailable",
      reason: /malformed|unexpected|invalid|parse/i.test(message) ? "malformed" : "unreachable",
      baseUrl: source?.baseUrl ?? null,
      message,
    }
  }
}

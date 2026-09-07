"use client"

/**
 * The public base a platform console must be pointed at for inbound webhooks,
 * resolved for whichever host this page is running on.
 *
 * Six adapter forms need the same answer and used to derive it six ways, all
 * of them assuming the cloudflared tunnel. A cloud install has no tunnel and
 * needs none, so those forms told a correctly configured deployment to go and
 * start something that does not apply to it, while the address that actually
 * works never appeared in the product at all.
 *
 * The host profile, not `isTauri()` and not connector reach, decides the
 * shape:
 *
 *   - `desktop` publishes an unprefixed cloudflared tunnel straight at the
 *     standalone connectors server.
 *   - `mobile-companion` is a remote control for a host, so the ingress is
 *     that host's, and the only origin the phone can learn is the tunnel one
 *     reported by `companion_endpoints`.
 *   - `cloud-companion` and `headless` serve the connectors router nested
 *     under `/connectors` on their own origin.
 *   - `web-standalone` has no host at all and can receive nothing.
 *
 * `useConnectorControlReach()` is deliberately NOT the input here. It answers
 * whether the connector controls can be driven from this shell, which is a
 * different question, and it reads `true` on a headless profile. A form that
 * passed it as `isDesktop` produced a tunnel URL for a host that has no
 * tunnel.
 */

import { useEffect, useState } from "react"

import { useHostProfile } from "@/hooks/use-host-profile"
import { useTunnelStatus } from "@/hooks/use-tunnel-status"
import { refreshCompanionEndpoints } from "@/lib/connectivity/endpoint-refresh"
import { resolveLarkApiBase } from "@/lib/connectors/lark-web/entry-client"
import { resolveConnectorsIngressBase } from "@/lib/connectors/server-transport"

/**
 * Why there is no usable ingress base.
 *
 * Kept as separate values rather than one "unavailable" because each has a
 * different remedy, and collapsing them is how the cloud case ended up being
 * shown the desktop's advice.
 */
export type ConnectorIngressReason =
  | "ready"
  /** Still probing. Cards should hold rather than claim either outcome. */
  | "loading"
  /** Desktop shape with no tunnel running. The remedy is to start one. */
  | "tunnel-off"
  /** Cloud or headless host with no resolvable public origin. */
  | "origin-missing"
  /** A browser with no host behind it. Nothing can receive an inbound POST. */
  | "unsupported"

export interface ConnectorIngress {
  /** Public base with no trailing slash, or null when nothing is reachable. */
  base: string | null
  /** True until the first probe settles. */
  loading: boolean
  reason: ConnectorIngressReason
  /**
   * Whether the ingress takes the desktop shape. Cards use it to pick between
   * "start the tunnel" and "configure a public origin", and it is a property
   * of the ingress rather than of the shell, so a phone reading its paired
   * desktop's tunnel reports `true`.
   */
  desktopShape: boolean
}

export interface UseConnectorIngressOptions {
  /** Test seam for the paired host's endpoint report. */
  loadCompanionEndpoints?: typeof refreshCompanionEndpoints
  /** Test seam for the desktop tunnel poll. */
  tunnelLoader?: Parameters<typeof useTunnelStatus>[0]
  /** Test seam for the configured cloud origin. */
  publicOrigin?: () => string | null
}

function defaultPublicOrigin(): string | null {
  const configured = resolveLarkApiBase()
  if (configured) return configured
  return typeof window === "undefined" ? null : window.location.origin
}

export function useConnectorIngress(options: UseConnectorIngressOptions = {}): ConnectorIngress {
  const profile = useHostProfile()
  const tunnel = useTunnelStatus(options.tunnelLoader)
  const loadEndpoints = options.loadCompanionEndpoints ?? refreshCompanionEndpoints
  const readOrigin = options.publicOrigin ?? defaultPublicOrigin

  // Only the companion branch needs an async read. Held as its own state so
  // the desktop and cloud branches stay synchronous and never flash a
  // loading card they do not need.
  const [companion, setCompanion] = useState<{ url: string | null; loading: boolean }>({
    url: null,
    loading: true,
  })

  const isCompanionShell = profile === "mobile-companion"
  useEffect(() => {
    if (!isCompanionShell) return
    let cancelled = false
    void (async () => {
      try {
        const config = await loadEndpoints()
        if (!cancelled) setCompanion({ url: config?.tunnelBaseUrl ?? null, loading: false })
      } catch {
        if (!cancelled) setCompanion({ url: null, loading: false })
      }
    })()
    return () => {
      cancelled = true
    }
    // `loadEndpoints` is a stable default or a test seam, and re-running on a
    // fresh closure identity would poll the host on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompanionShell])

  if (profile === "web-standalone") {
    return { base: null, loading: false, reason: "unsupported", desktopShape: false }
  }

  if (profile === "desktop") {
    const base = resolveConnectorsIngressBase({ isDesktop: true, tunnelUrl: tunnel.url })
    return {
      base,
      loading: tunnel.loading,
      reason: tunnel.loading ? "loading" : base ? "ready" : "tunnel-off",
      desktopShape: true,
    }
  }

  if (isCompanionShell) {
    // A phone paired over LAN has a `baseUrl`, but it is a private address and
    // pasting it into a platform console would advertise something the
    // platform can never reach. The tunnel origin is the only base the phone
    // can learn that is known to be public, so its absence reports as
    // `tunnel-off` even when the paired host is a cloud deployment that needs
    // no tunnel. Resolving that case means asking the host, which this hook
    // deliberately does not do.
    const base = resolveConnectorsIngressBase({ isDesktop: true, tunnelUrl: companion.url })
    return {
      base,
      loading: companion.loading,
      reason: companion.loading ? "loading" : base ? "ready" : "tunnel-off",
      desktopShape: true,
    }
  }

  const base = resolveConnectorsIngressBase({ isDesktop: false, publicBase: readOrigin() })
  return {
    base,
    loading: false,
    reason: base ? "ready" : "origin-missing",
    desktopShape: false,
  }
}

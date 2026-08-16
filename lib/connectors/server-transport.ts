/**
 * Inbound HTTP/WS server gating for the connector subsystem.
 *
 * Static-export means `app/api/` does not exist at runtime, so any adapter
 * that receives events over an inbound HTTP webhook (Lark webhook mode,
 * Slack Events API, Telegram webhook, WeChat OA, …) or a reverse-WebSocket
 * (OneBot, where QQ clients dial IN) depends on the Rust axum server started
 * via `connectors_start_server`. Long-poll / gateway / forward-WS adapters
 * dial OUT and need no local listener.
 *
 * This module owns the single source of truth for (a) the port the axum
 * server binds and (b) the predicate deciding whether a given enabled adapter
 * requires that server. The `ConnectorBusProvider` starts the server on boot
 * iff at least one enabled adapter satisfies the predicate.
 */

import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

/**
 * Loopback port the Rust axum connectors server binds. Shared with the tunnel
 * card's default local target so the tunnel origin and the bound port can't
 * drift. The public reachability for webhook adapters comes from the tunnel
 * (cloudflared), never from binding a non-loopback interface.
 */
export const CONNECTORS_SERVER_PORT = 7842

/**
 * True when an enabled adapter needs the inbound axum server running:
 *   - it exposes a `webhook` transport AND the row is configured for `webhook`
 *     (Rust verifies the signature and emits `connectors://webhook/<id>`), OR
 *   - it exposes a `reverse-ws` transport AND is not configured as
 *     `forward-ws` (OneBot narrows to both modes at build time, so the row's
 *     active `transportMode` disambiguates: reverse-ws dials in → needs the
 *     `/ws/onebot/<id>` server; forward-ws dials out → does not).
 *
 * Both branches key off the row's active `transportMode` so a dual-mode adapter
 * (Discord: gateway + webhook) only starts the server when actually in webhook
 * mode; gateway/long-poll/forward-ws rows all dial outbound and return false.
 */
export function adapterNeedsInboundServer(
  adapter: Pick<PlatformAdapter, "meta">,
  row: Pick<AdapterInstanceRow, "transportMode">
): boolean {
  const modes = adapter.meta.transportModes
  if (modes.includes("webhook") && row.transportMode === "webhook") return true
  if (modes.includes("reverse-ws") && row.transportMode !== "forward-ws") return true
  return false
}

/**
 * Path prefix the headless companion nests the connectors axum router under
 * (`server.rs`, headless-only). The desktop serves the same router standalone
 * on `CONNECTORS_SERVER_PORT`, so its routes carry no prefix — which is exactly
 * why the public URL cannot be derived the same way on both hosts.
 */
export const HEADLESS_CONNECTORS_PREFIX = "/connectors"

export interface ConnectorsIngressInput {
  /** `isTauri()` — the desktop reaches the public internet via cloudflared. */
  isDesktop: boolean
  /** Tunnel origin, when a tunnel is running. Desktop only. */
  tunnelUrl?: string | null
  /**
   * Public origin of the companion deployment. Same-origin in the reference
   * compose (Caddy serves the static export and proxies `/connectors/*`), so
   * callers normally pass `resolveLarkApiBase() || window.location.origin`.
   */
  publicBase?: string | null
}

/**
 * Public base a platform should be pointed at for inbound webhooks, per host.
 *
 * The form used to derive this from the cloudflared tunnel unconditionally, so
 * a cloud install saw an empty state telling it to go configure a tunnel it
 * neither has nor needs — while the address that actually works,
 * `https://<domain>/connectors/webhook/<type>/<id>`, appeared nowhere in the
 * product. Returns `null` when nothing is reachable yet, which is a real state
 * on the desktop (no tunnel) and a misconfiguration in the cloud (no origin).
 */
export function resolveConnectorsIngressBase(input: ConnectorsIngressInput): string | null {
  const trim = (value?: string | null) => value?.trim().replace(/\/+$/, "") || null
  if (input.isDesktop) return trim(input.tunnelUrl)
  const base = trim(input.publicBase)
  return base ? `${base}${HEADLESS_CONNECTORS_PREFIX}` : null
}

/** Inbound webhook path for an adapter — `POST /webhook/{type}/{id}` in `axum_app.rs`. */
export function connectorWebhookPath(adapterType: string, adapterId: string): string {
  return `/webhook/${adapterType}/${adapterId}`
}

/**
 * Lark send-as-user OAuth relay path (`oauth_lark_callback` in `axum_app.rs`).
 *
 * Feishu's console only accepts http/https redirect URLs, so the authorize
 * step registers `{ingressBase}{LARK_OAUTH_RELAY_PATH}` and the relay bounces
 * the code onto the connector event bus (headless) and the desktop deep-link
 * scheme. Lives here rather than in the settings form because the brain has to
 * derive the same URL with no UI in the picture.
 */
export const LARK_OAUTH_RELAY_PATH = "/oauth/lark/callback"

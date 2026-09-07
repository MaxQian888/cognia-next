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

import type { PlatformAdapter, TransportMode } from "@/types/connectors/adapter"

/**
 * Loopback port the Rust axum connectors server binds. Shared with the tunnel
 * card's default local target so the tunnel origin and the bound port can't
 * drift. The public reachability for webhook adapters comes from the tunnel
 * (cloudflared), never from binding a non-loopback interface.
 */
export const CONNECTORS_SERVER_PORT = 7842

/**
 * The transport a built adapter actually runs.
 *
 * The adapter's declared `transportModes` is the authority whenever it names
 * exactly one transport, and the row only disambiguates a genuinely dual-mode
 * adapter. That order matters because the two are independent fields with
 * nothing keeping them in agreement:
 *
 *   - `lark`, `slack` and `telegram` declare a SINGLE mode computed from
 *     `settings.transport` (`adapters/lark/index.ts`, `slack/index.ts`,
 *     `telegram/index.ts`), which is a different persisted field from
 *     `row.transportMode`. The config forms happen to write both from one
 *     variable, but `patchAdapterInstanceSettings` merges into `settings`
 *     without touching `transportMode`, and no migration or invariant ties
 *     them together. A row whose two halves disagree used to build a webhook
 *     adapter while the receiver stayed down, which reads as a healthy bot
 *     that answers nothing.
 *   - `wechat-oa` declares webhook as its ONLY transport. Any row value other
 *     than `"webhook"` used to mean the server never started, even though the
 *     adapter has no other way to receive.
 *
 * Reading the row first also let a lark row that says `"webhook"` start the
 * receiver for an adapter built as a long connection, so deferring to the
 * declaration is the more correct answer in both directions.
 */
function effectiveTransportMode(
  modes: readonly TransportMode[],
  rowMode: TransportMode | undefined
): TransportMode | undefined {
  return modes.length === 1 ? modes[0] : rowMode
}

/**
 * True when an enabled adapter needs the inbound axum server running:
 *   - it exposes a `webhook` transport AND runs in `webhook` mode (Rust
 *     verifies the signature and emits `connectors://webhook/<id>`), OR
 *   - it exposes a `reverse-ws` transport AND is not running as `forward-ws`
 *     (OneBot narrows to both modes at build time, so the row disambiguates:
 *     reverse-ws dials in and needs the `/ws/onebot/<id>` server, forward-ws
 *     dials out and does not).
 *
 * A dual-mode adapter (Discord, QQ Official: gateway + webhook) only starts the
 * server when the row puts it in webhook mode. Gateway, long-poll and
 * forward-ws all dial outbound and return false.
 *
 * `transportMode` is widened to optional against the Dexie interface, which
 * declares it required. Nothing enforces that at runtime: the field is absent
 * from rows this predicate is handed in `install-connector-runtime`, whose own
 * fixtures already type it optional. Typing it required here would make the
 * unresolved branch unreachable to the type checker while staying reachable in
 * production, which is how the wechat-oa case stayed invisible.
 */
export function adapterNeedsInboundServer(
  adapter: Pick<PlatformAdapter, "meta">,
  row: { transportMode?: TransportMode | null }
): boolean {
  const modes = adapter.meta.transportModes
  const mode = effectiveTransportMode(modes, row.transportMode ?? undefined)
  if (modes.includes("webhook") && mode === "webhook") return true
  if (modes.includes("reverse-ws") && mode !== "forward-ws") return true
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
  /**
   * Whether the ingress takes the DESKTOP shape: an unprefixed cloudflared
   * tunnel pointed straight at the standalone connectors server. This is a
   * statement about the shape of the entry point, not about which shell is
   * asking. A phone or browser paired to a desktop reads the same shape and
   * passes `true`, because the URL the platform must be given is that
   * desktop's tunnel origin with no path prefix.
   */
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

/**
 * Relay path for every other connector's OAuth (`oauth_connector_callback` in
 * `axum_app.rs`).
 *
 * Same reason as the Lark relay — Slack's console, like Feishu's, refuses a
 * custom scheme and only registers http/https — but parameterised by kind, so
 * the next platform needs no new route. Lark keeps its own path: it is already
 * registered byte-for-byte in existing installs' consoles.
 *
 * Whichever host is running derives the same absolute URL by prefixing
 * `resolveConnectorsIngressBase()`, so the brain can produce it with no UI in
 * the picture.
 */
export function connectorOAuthRelayPath(kind: string): string {
  return kind === "lark" ? LARK_OAUTH_RELAY_PATH : `/oauth/connector/${kind}/callback`
}

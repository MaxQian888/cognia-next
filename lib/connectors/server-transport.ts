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

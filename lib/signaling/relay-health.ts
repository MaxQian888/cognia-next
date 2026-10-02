/**
 * The pure half of the rendezvous health check (ADR-0170).
 *
 * `GET /healthz` on the signaling host answers with `{ ok, backend, version,
 * capabilities }`. Deciding what that body means is the same question in the
 * app's Connectivity settings (`relay-probe.ts`), the public status Worker and
 * the external status probe (`services/status-server/`), so the decision lives
 * here with no platform transport, no `@/` import and no Node built-in. Both
 * standalone services import this file by relative path and bundle it.
 */

/**
 * The signaling protocol generation this client speaks. Mirrors
 * `SIGNALING_PROTOCOL_VERSION` in `./types`, which cannot be imported here:
 * that module also declares WebRTC DOM types a Worker or Node bundle lacks.
 * `relay-health.test.ts` pins the two equal.
 */
export const RELAY_HEALTH_PROTOCOL_VERSION = 2 as const

export interface RelayCapabilities {
  protocol: number
  lanes: string[]
  relayDataLane: boolean
}

/** The verdicts a health body alone can produce. */
export type RelayHealthState =
  /** A Cognia rendezvous that serves the application data lane. */
  | "ready"
  /** A Cognia rendezvous without a capabilities block or without the data lane. */
  | "legacy"
  /** Something that is not a Cognia rendezvous. */
  | "not-a-relay"

export interface RelayHealthClassification {
  state: RelayHealthState
  backend?: string
  version?: string
  capabilities?: RelayCapabilities
}

/**
 * `wss://host/signaling` becomes `https://host/healthz`. Both backends
 * (the axum server and the Cloudflare Worker) mount `/healthz` at the root,
 * whatever path the WebSocket is on, so the signaling path is dropped rather
 * than rewritten. `ws://` becomes `http://` for a local rendezvous.
 */
export function relayHealthUrl(signalingUrl: string): string | null {
  let url: URL
  try {
    url = new URL(signalingUrl.trim())
  } catch {
    return null
  }
  if (url.protocol === "wss:" || url.protocol === "https:") url.protocol = "https:"
  else if (url.protocol === "ws:" || url.protocol === "http:") url.protocol = "http:"
  else return null
  if (!url.hostname) return null
  url.pathname = "/healthz"
  url.search = ""
  url.hash = ""
  return url.toString()
}

interface HealthzBody {
  ok?: unknown
  backend?: unknown
  version?: unknown
  capabilities?: {
    protocol?: unknown
    lanes?: unknown
    relayDataLane?: unknown
  }
}

/** Pure classification of a health body, so the verdict is testable alone. */
export function classifyHealthz(body: unknown): RelayHealthClassification {
  if (!body || typeof body !== "object") return { state: "not-a-relay" }
  const health = body as HealthzBody
  if (health.ok !== true || typeof health.version !== "string") return { state: "not-a-relay" }
  const backend = typeof health.backend === "string" ? health.backend : undefined
  const raw = health.capabilities
  if (!raw || typeof raw !== "object") {
    return { state: "legacy", backend, version: health.version }
  }
  const lanes = Array.isArray(raw.lanes)
    ? raw.lanes.filter((lane): lane is string => typeof lane === "string")
    : []
  const capabilities: RelayCapabilities = {
    protocol: typeof raw.protocol === "number" ? raw.protocol : 0,
    lanes,
    relayDataLane: raw.relayDataLane === true || lanes.includes("data"),
  }
  return {
    state: capabilities.relayDataLane ? "ready" : "legacy",
    backend,
    version: health.version,
    capabilities,
  }
}

/** Whether this client and the probed relay speak the same generation. */
export function relayProtocolMatches(capabilities: RelayCapabilities | undefined): boolean {
  return capabilities?.protocol === RELAY_HEALTH_PROTOCOL_VERSION
}
